import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

const execAsync = promisify(exec);
let client: LanguageClient;

async function getUvInstallCommand(): Promise<string> {
  const platform = os.platform();

  if (platform === "win32") {
    // Windows: Use PowerShell
    return 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"';
  } else {
    // macOS and Linux: Use curl
    return "curl -LsSf https://astral.sh/uv/install.sh | sh";
  }
}

async function findUvPath(): Promise<string | null> {
  // Common locations where uv might be installed
  const platform = os.platform();
  const homeDir = os.homedir();

  const possiblePaths = [
    // Check if uv is in PATH
    "uv",
    // Common installation locations
    path.join(homeDir, ".cargo", "bin", "uv"),
    path.join(homeDir, ".local", "bin", "uv"),
  ];

  if (platform === "win32") {
    possiblePaths.push(
      path.join(homeDir, ".cargo", "bin", "uv.exe"),
      path.join(homeDir, "AppData", "Local", "uv", "bin", "uv.exe"),
    );
  }

  for (const uvPath of possiblePaths) {
    try {
      await execAsync(`"${uvPath}" --version`);
      return uvPath;
    } catch {
      // Continue checking other paths
    }
  }

  return null;
}

async function installUv(outputChannel: vscode.OutputChannel): Promise<string> {
  outputChannel.appendLine("Installing uv package manager...");
  outputChannel.show();

  const installCommand = await getUvInstallCommand();

  try {
    const { stdout, stderr } = await execAsync(installCommand, {
      env: {
        ...process.env,
        // Ensure the installer adds to PATH
        UV_INSTALL_DIR: path.join(os.homedir(), ".local", "bin"),
      },
    });

    if (stdout) {
      outputChannel.appendLine(stdout);
    }
    if (stderr) {
      outputChannel.appendLine(stderr);
    }

    outputChannel.appendLine("uv installed successfully!");

    // Find where uv was installed
    const uvPath = await findUvPath();
    if (!uvPath) {
      throw new Error("uv was installed but cannot be found");
    }

    return uvPath;
  } catch (error) {
    outputChannel.appendLine(`Error installing uv: ${error}`);
    throw error;
  }
}

async function ensureUvInstalled(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<string> {
  // Check if uv is already available
  let uvPath = await findUvPath();
  if (uvPath) {
    outputChannel.appendLine(`Found uv at: ${uvPath}`);
    return uvPath;
  }

  // Ask user for permission to install
  const selection = await vscode.window.showInformationMessage(
    "The uv package manager is required for this extension but was not found. Would you like to install it?",
    "Install",
    "Cancel",
  );

  if (selection !== "Install") {
    throw new Error("uv installation cancelled by user");
  }

  // Install uv with progress
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Installing uv package manager",
      cancellable: false,
    },
    async () => {
      return await installUv(outputChannel);
    },
  );
}

async function ensureLanguageServerDependencies(
  serverPath: string,
  uvPath: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  try {
    const venvPath = path.join(serverPath, ".venv");
    
    // Only sync if .venv doesn't exist
    if (!fs.existsSync(venvPath)) {
      outputChannel.appendLine("Installing dependencies...");
      await execAsync(`"${uvPath}" sync`, { cwd: serverPath });
      outputChannel.appendLine("Dependencies ready.");
    } else {
      outputChannel.appendLine("Virtual environment already exists, skipping dependency installation.");
    }
  } catch (error) {
    outputChannel.appendLine(`Error: ${error}`);
    throw new Error(`Failed to set up language server: ${error}`);
  }
}

async function syncDependencies(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  let uvPath: string;
  
  // Read uvPath from settings if provided
  const configUvPath = vscode.workspace.getConfiguration("hovercraft").get<string>("uvPath");
  
  if (configUvPath && configUvPath.trim()) {
    uvPath = configUvPath.trim();
  } else {
    // Use stored uvPath or ensure uv is installed
    uvPath = context.globalState.get("uvPath") || await ensureUvInstalled(context, outputChannel);
  }

  const serverPath = context.asAbsolutePath("hovercraft");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Syncing Hovercraft Dependencies",
      cancellable: false,
    },
    async () => {
      try {
        outputChannel.appendLine("Manually syncing dependencies...");
        await execAsync(`"${uvPath}" sync`, { cwd: serverPath });
        outputChannel.appendLine("Dependencies synced successfully.");
        vscode.window.showInformationMessage("Hovercraft dependencies synced successfully.");
      } catch (error) {
        outputChannel.appendLine(`Error syncing dependencies: ${error}`);
        vscode.window.showErrorMessage(`Failed to sync dependencies: ${error}`);
        throw error;
      }
    }
  );
}

async function startLanguageServer(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  if (client && client.state === 2) { // Running state
    vscode.window.showInformationMessage("Language server is already running.");
    return;
  }

  try {
    await client.start();
    vscode.window.showInformationMessage("Hovercraft language server started.");
  } catch (error) {
    outputChannel.appendLine(`Error starting language server: ${error}`);
    vscode.window.showErrorMessage(`Failed to start language server: ${error}`);
  }
}

async function stopLanguageServer(outputChannel: vscode.OutputChannel): Promise<void> {
  if (!client || client.state === 1) { // Stopped state
    vscode.window.showInformationMessage("Language server is not running.");
    return;
  }

  try {
    await client.stop();
    vscode.window.showInformationMessage("Hovercraft language server stopped.");
  } catch (error) {
    outputChannel.appendLine(`Error stopping language server: ${error}`);
    vscode.window.showErrorMessage(`Failed to stop language server: ${error}`);
  }
}

async function restartLanguageServer(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Restarting Hovercraft Language Server",
      cancellable: false,
    },
    async () => {
      try {
        if (client && client.state === 2) { // Running state
          await client.stop();
        }
        await client.start();
        vscode.window.showInformationMessage("Hovercraft language server restarted.");
      } catch (error) {
        outputChannel.appendLine(`Error restarting language server: ${error}`);
        vscode.window.showErrorMessage(`Failed to restart language server: ${error}`);
      }
    }
  );
}

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Hovercraft Language Server Trace");

  let uvPath: string;

  // Read uvPath from settings if provided
  const configUvPath = vscode.workspace.getConfiguration("hovercraft").get<string>("uvPath");

  if (configUvPath && configUvPath.trim()) {
    uvPath = configUvPath.trim();
    outputChannel.appendLine(`Using uv from user configuration: ${uvPath}`);
  } else {
    // Ensure uv is installed
    uvPath = await ensureUvInstalled(context, outputChannel);
    context.globalState.update("uvPath", uvPath);
  }

  const serverPath = context.asAbsolutePath("hovercraft");

  // Ensure Python dependencies are installed
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Setting up Hovercraft Language Server",
        cancellable: false,
      },
      async () => {
        await ensureLanguageServerDependencies(serverPath, uvPath, outputChannel);
      },
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to set up language server: ${error}`);
    return;
  }

  // Server options using the found/installed uv
  const serverOptions: ServerOptions = {
    run: {
      command: uvPath,
      args: ["run", "hovercraft-server"],
      options: {
        cwd: serverPath,
      },
    },
    debug: {
      command: uvPath,
      args: ["run", "hovercraft-server", "--debug"],
      options: {
        cwd: serverPath,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYGLS_LOG_LEVEL: "debug",
        },
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", pattern: "**/*" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/.vscode/hovercraft.*.csv"),
    },
    outputChannelName: "Hovercraft Language Server",
    traceOutputChannel: outputChannel,
    revealOutputChannelOn: 3, // Show output on error
  };

  client = new LanguageClient(
    "hovercraftServer",
    "Hovercraft Language Server",
    serverOptions,
    clientOptions,
  );

  // Register commands
  const syncDependenciesCommand = vscode.commands.registerCommand(
    "hovercraft.syncDependencies",
    () => syncDependencies(context, outputChannel)
  );
  const startServerCommand = vscode.commands.registerCommand(
    "hovercraft.startServer",
    () => startLanguageServer(context, outputChannel)
  );
  const stopServerCommand = vscode.commands.registerCommand(
    "hovercraft.stopServer",
    () => stopLanguageServer(outputChannel)
  );
  const restartServerCommand = vscode.commands.registerCommand(
    "hovercraft.restartServer",
    () => restartLanguageServer(context, outputChannel)
  );
  
  context.subscriptions.push(syncDependenciesCommand);
  context.subscriptions.push(startServerCommand);
  context.subscriptions.push(stopServerCommand);
  context.subscriptions.push(restartServerCommand);

  // Register the client
  context.subscriptions.push(client);

  // Start the client
  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
