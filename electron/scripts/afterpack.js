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
    exePath = path.join(appOutDir, productName);
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
