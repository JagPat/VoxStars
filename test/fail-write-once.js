/* Test-only preload: injects exactly one transient failure into the atomic
   state write, the first time a sentinel file exists. Lets a durability test
   force a mid-flight write failure deterministically. Arm by creating the file
   at process.env.VOX_TEST_FAIL_SENTINEL; the shim deletes it when it fires. */
const fs = require('fs');
const realOpen = fs.promises.open.bind(fs.promises);
let fired = false;
const sentinel = process.env.VOX_TEST_FAIL_SENTINEL;
fs.promises.open = async (p, ...rest) => {
  if (!fired && sentinel && String(p).endsWith('state.json.tmp')) {
    let armed = false;
    try { armed = fs.existsSync(sentinel); } catch (_) {}
    if (armed) {
      fired = true;
      try { fs.unlinkSync(sentinel); } catch (_) {}
      await new Promise(r => setTimeout(r, 120)); // stall so a second request can queue behind us
      const e = new Error('EIO simulated (test)'); e.code = 'EIO';
      throw e;
    }
  }
  return realOpen(p, ...rest);
};
