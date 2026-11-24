// Synthetic process fixture only: parent exits immediately while its child lives.
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const child = spawn(process.execPath, [join(__dirname, "trial-job-child.cjs")], { stdio: "ignore" });
child.unref();
setTimeout(() => {}, 350);
