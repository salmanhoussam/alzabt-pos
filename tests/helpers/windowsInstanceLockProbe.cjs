/* Synthetic-only Electron lock probe. Never launches Alzabt POS or opens a real ledger. */
const fs = require("node:fs");
const path = require("node:path");

if (process.versions.electron) {
  const { app } = require("electron");
  const [root, selected, role] = process.argv.slice(-3);
  if (!root || !selected || !role || !path.resolve(selected).startsWith(path.resolve(root) + path.sep)) process.exit(2);
  app.commandLine.appendSwitch("disable-background-networking");
  app.setName("Synthetic-Instance-Lock-Probe");
  const acquired = app.requestSingleInstanceLock();
  let fd;
  if (acquired) {
    app.setPath("userData", selected);
    app.setPath("sessionData", selected);
    fd = fs.openSync(path.join(selected, "synthetic-ledger.txt"), "a");
    fs.writeSync(fd, "opened:" + role + "\n");
  }
  process.stdout.write("REPORT:" + JSON.stringify({ role, acquired, openedLedger: acquired }) + "\n");
  if (!acquired) app.exit(0);
  else {
    const stopPath = path.join(path.dirname(selected), "stop-" + role);
    const check = setInterval(() => {
      if (!fs.existsSync(stopPath)) return;
      clearInterval(check);
      fs.closeSync(fd);
      process.stdout.write("CLOSED\\n", () => {
        app.releaseSingleInstanceLock();
        app.exit(0);
      });
    }, 50);
    setTimeout(() => { try { fs.closeSync(fd); } catch {} app.exit(0); }, 25000);
  }
} else {
  const os = require("node:os");
  const { spawn } = require("node:child_process");
  const assert = require("node:assert/strict");
  const root = fs.mkdtempSync(path.join(process.cwd(), "node_modules", "synthetic-product-lock-"));
  const electron = path.join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");
  const observed = [];
  const watcher = fs.watch(root, { recursive: true }, (kind, file) => observed.push({ kind, file: String(file) }));
  const env = { ...process.env, APPDATA: path.join(root,"appdata"), LOCALAPPDATA: path.join(root,"localappdata"),
    TEMP: path.join(root,"temp"), TMP: path.join(root,"temp") };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(dir, { recursive: true });

  function launch(common, selected, role) {
    const cp = spawn(electron, ["--user-data-dir=" + common, "--disable-background-networking", __filename, root, selected, role],
      { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    cp.stdout.on("data", (chunk) => { output += chunk; });
    cp.stderr.on("data", (chunk) => { errors += chunk; });
    const report = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("probe report timeout: " + role)), 15000);
      cp.stdout.on("data", () => {
        const match = output.match(/REPORT:(\{[^\r\n]+\})/);
        if (match) { clearTimeout(deadline); resolve(JSON.parse(match[1])); }
      });
      cp.on("error", (err) => { clearTimeout(deadline); reject(err); });
      cp.on("exit", (code) => {
        if (!output.includes("REPORT:")) { clearTimeout(deadline); reject(new Error("probe exited before report: " + code + " " + errors.slice(0,300))); }
      });
    });
    const exited = new Promise((resolve) => cp.on("exit", (code, signal) => resolve({ code, signal })));
    return { cp, report, exited, getOutput: () => output,
      stop: () => fs.writeFileSync(path.join(path.dirname(selected), "stop-" + role), "stop", {flag:"wx"}) };
  }
  async function runOrder(firstRole, secondRole) {
    const dir = fs.mkdtempSync(path.join(root, "order-"));
    const common = path.join(dir, "common");
    const paths = { normal: path.join(dir, "normal"), demo: path.join(dir, "demo") };
    for (const d of [common, paths.normal, paths.demo]) fs.mkdirSync(d);
    for (const d of [paths.normal, paths.demo]) fs.writeFileSync(path.join(d,"synthetic-ledger.txt"),"SYNTHETIC\n");
    const secondBefore = fs.readFileSync(path.join(paths[secondRole],"synthetic-ledger.txt"),"utf8");
    const first = launch(common, paths[firstRole], firstRole);
    const a = await first.report;
    assert.equal(a.acquired, true);
    const second = launch(common, paths[secondRole], secondRole);
    const b = await second.report;
    assert.equal(first.cp.exitCode, null);
    assert.equal(b.acquired, false);
    assert.equal(b.openedLedger, false);
    assert.equal(fs.readFileSync(path.join(paths[secondRole],"synthetic-ledger.txt"),"utf8"), secondBefore);
    await second.exited;
    first.stop();
    const firstExit = await first.exited;
    assert.equal(firstExit.code, 0);
    assert.match(first.getOutput(), /CLOSED/);
    const restart = launch(common, paths[secondRole], secondRole + "-restart");
    const c = await restart.report;
    assert.equal(c.acquired, true);
    restart.stop();
    assert.equal((await restart.exited).code, 0);
    return { firstRole, secondRole, first: a, second: b, restarted: c, firstExit };
  }
  async function runKill() {
    const dir = fs.mkdtempSync(path.join(root, "crash-"));
    const common = path.join(dir,"common"), selected = path.join(dir,"demo");
    fs.mkdirSync(common); fs.mkdirSync(selected);
    fs.writeFileSync(path.join(selected,"synthetic-ledger.txt"),"SYNTHETIC\n");
    const first = launch(common,selected,"crash");
    assert.equal((await first.report).acquired,true);
    assert.equal(first.cp.kill("SIGKILL"),true); // only this newly created synthetic child
    const killed = await first.exited;
    const retry = launch(common,selected,"post-kill");
    const after = await retry.report;
    assert.equal(after.acquired,true);
    retry.stop();
    assert.equal((await retry.exited).code,0);
    return { killed, after };
  }
  (async () => {
    const orders = [await runOrder("normal","demo"), await runOrder("demo","normal")];
    const crash = await runKill();
    watcher.close();
    const summary = { root, orders, crash, observedEvents: observed };
    fs.writeFileSync(path.join(root,"results.json"), JSON.stringify(summary,null,2), {flag:"wx"});
    console.log(JSON.stringify({root, orders, crash, observedEventCount:observed.length}));
  })().catch((err) => { watcher.close(); console.error(err.stack); process.exitCode=1; });
}
