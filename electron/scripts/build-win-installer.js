const path = require('path');
const { spawnSync } = require('child_process');
const { rcedit } = require('rcedit');

const electronDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronDir, '..');
const outputDir = path.join(repoRoot, 'downloads', 'single-exe');
const unpackedDir = path.join(outputDir, 'win-unpacked');
const exePath = path.join(unpackedDir, 'ROTEX Desktop.exe');
const iconPath = path.join(electronDir, 'icon.ico');
const builderCli = require.resolve('electron-builder/out/cli/cli.js');
const pkg = require(path.join(electronDir, 'package.json'));

function run(args) {
  const result = spawnSync(process.execPath, [builderCli, ...args], {
    cwd: electronDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      USE_HARD_LINKS: 'false',
    },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

(async () => {
  run([
    '--win',
    'dir',
    '--config.directories.output=../downloads/single-exe',
    '--config.win.signAndEditExecutable=false',
  ]);

  await rcedit(exePath, {
    icon: iconPath,
    'version-string': {
      FileDescription: 'ROTEX Desktop',
      ProductName: 'ROTEX Desktop',
      CompanyName: 'ROTEX',
    },
    'file-version': pkg.version,
    'product-version': pkg.version,
  });

  run([
    '--win',
    'nsis',
    '--prepackaged',
    '../downloads/single-exe/win-unpacked',
    '--config.directories.output=../downloads/single-exe',
    '--config.win.signAndEditExecutable=false',
  ]);
})();
