/**
 * Electron Fuses — applied after electron-builder packs the app.
 * Prevents: ELECTRON_RUN_AS_NODE, --inspect debugging, NODE_OPTIONS injection,
 * and running the app from an extracted ASAR directory.
 *
 * Run `npm install --save-dev @electron/fuses` in the electron/ folder before building.
 */

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('path');

module.exports = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const platformName = packager.platform.name; // 'windows', 'mac', 'linux'
  const productName = packager.appInfo.productFilename; // 'ROTEX Desktop'

  let exePath;
  if (platformName === 'windows') {
    exePath = path.join(appOutDir, `${productName}.exe`);
  } else if (platformName === 'mac') {
    exePath = path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
  } else {
    // Linux sanitizes productName into a filesystem-safe executable name
    // (LinuxPackager.executableName, e.g. "rotex-desktop") rather than
    // using it verbatim -- using productName directly here ("ROTEX
    // Desktop", with the space) pointed at a file that doesn't exist and
    // failed every linux build with ENOENT, confirmed via the actual
    // GitHub Actions run logs. packager.executableName is the real,
    // build-computed name for whichever platform is actually packaging,
    // so this works instead of guessing at a specific sanitization rule.
    exePath = path.join(appOutDir, packager.executableName || productName);
  }

  console.log(`[afterPack] Applying security fuses to: ${exePath}`);

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  console.log('[afterPack] Security fuses applied.');
};
