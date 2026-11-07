// Launches a real VS Code with Portside loaded and runs the checks in ./suite.
//   npm run test:vscode
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'portside-vscode-'));
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions'],
    extensionTestsEnv: { PORTSIDE_TEST_WORKSPACE: workspace },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
