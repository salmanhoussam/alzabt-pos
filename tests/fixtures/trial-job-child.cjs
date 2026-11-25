const fs = require("node:fs");
fs.writeFileSync(process.env.TRIAL_JOB_MARKER, "started");
setTimeout(() => fs.writeFileSync(process.env.TRIAL_JOB_MARKER, "done"), 1400);
