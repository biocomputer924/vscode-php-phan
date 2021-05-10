import * as childProcess from "child_process"
import * as fs from "fs"
import * as net from "net"
import * as path from "path"
import * as semver from "semver"
import * as url from "url"
import * as vscode from "vscode"
import { LanguageClient, LanguageClientOptions, StreamInfo } from "vscode-languageclient/node"

type Config = ReturnType<typeof loadConfig>

export const activate = async function (context: import("vscode").ExtensionContext): Promise<void> {
	try {
		const config = loadConfig(context)

		await checkPhpVersion(config)

		await checkPhpAstInstalledAndSupported(config)

		await checkPhanSupportsLanguageServer(config)

		const phanConfigPaths = await vscode.workspace.findFiles("**/.phan/config.php")

		const phanRootPaths = phanConfigPaths.map(x => vscode.Uri.joinPath(x, "..", "..").fsPath)

		if (phanRootPaths.length == 0) {
			phanRootPaths.push(... vscode.workspace.workspaceFolders?.map(x => x.uri.fsPath) || [])
		}

		for (const phanRootPath of phanRootPaths) {
			const client = createLanguageClient(config, phanRootPath).start()

			context.subscriptions.push(client)
		}
	} catch (e) {
		if (e instanceof Error) {
			console.log(`Calling vscode.window.showErrorMessage ${e.message}`)

			await vscode.window.showErrorMessage(e.message)
		}
	}
}

const execFile = (path: string, args: string[]) => {
	return new Promise<[string, string]>((resolve, reject) => {
		childProcess.execFile(path, args, (err, stdout, stderr) => {
			if (err) {
				reject(err)
			}

			resolve([stdout, stderr])
		})
	})
}

const loadConfig = (context: import("vscode").ExtensionContext) => {
	const configuration = vscode.workspace.getConfiguration("php-phan")

	return {
		phpExecutablePath:
			configuration.get<string | null>("phpExecutablePath") || "php",
		phanScriptPath:
			configuration.get<string | null>("phanScriptPath") || context.asAbsolutePath(path.join("vendor", "phan", "phan", "phan")),
		phanArgs:
			configuration.get<string[]>("phanArgs", []),
		enableCompletion:
			configuration.get<boolean>("enableCompletion", true),
		enableDebugLog:
			configuration.get<boolean>("enableDebugLog", true),
		enableGoToDefinition:
			configuration.get<boolean>("enableGoToDefinition", true),
		enableHover:
			configuration.get<boolean>("enableHover", true),
		unusedVariableDetection:
			configuration.get<boolean>("unusedVariableDetection", true),
		redundantConditionDetection:
			configuration.get<boolean>("redundantConditionDetection", true)
	}
}

const checkPhpVersion = async (config: Config) => {
	let stdout: string

	try {
		[stdout] = await execFile(config.phpExecutablePath, ["--version"])
	} catch (err) {
		if (err.code === "ENOENT") {
			throw new Error(`PHP executable not found. Install PHP 7.2+ and add it to your PATH or set the phan.phpExecutablePath setting. Current`)
		}

		throw new Error(`Error spawning PHP: ${err.message}`)
	}

	const matches = stdout.match(/^PHP (\d+.\d+.\d+)/m)

	if (! matches) {
		throw new Error(`Error parsing PHP version. Please check the output of 'php --version'.`)
	}

	const version = matches[1]

	if (semver.lt(version, "7.2.0")) {
		throw new Error(`Phan 4.x needs at least PHP 7.2 installed. Version found: ${version}`)
	}
}

const checkPhpAstInstalledAndSupported = async (config: Config) => {
	let stdout = ""

	try {
		[stdout] = await execFile(config.phpExecutablePath, ["-r", `if (extension_loaded("ast")) { echo "ext-ast " . (new ReflectionExtension("ast"))->getVersion(); } else { echo "None"; }`])
	} catch (err) {
		throw new Error(`Error spawning PHP to determine php-ast version: ${err.message}`)
	}

	if (stdout.match(/^None/)) {
		return
	}

	const matches = stdout.match(/^ext-ast (\d+.\d+.\d+)/m)

	if (! matches) {
		throw new Error(`Error parsing php-ast module version. Please check the output of 'if (extension_loaded("ast")) { echo "ext-ast " . (new ReflectionExtension("ast"))->getVersion() } else { echo "None" }'.`)
	}

	const version = matches[1]

	if (semver.lt(version, "1.0.7")) {
		throw new Error(`Phan 4.x needs at least ext-ast 1.0.7 installed. Version found: ${version}`)
	}
}

const checkPhanSupportsLanguageServer = async (config: Config) => {
	if (! fs.statSync(config.phanScriptPath).isFile()) {
		throw new Error(`The setting phan.phanScriptPath refers to a path that does not exist. path: ${config.phanScriptPath}`)
	}

	let stdout = ""

	try {
		[stdout] = await execFile(config.phpExecutablePath, [config.phanScriptPath, "--extended-help"])
	} catch (err) {
		throw new Error(`Error spawning Phan to check for language server support: ${err.message}`)
	}

	const matches = stdout.match(/language-server/m)

	if (! matches) {
		throw new Error(`Language server support was not detected. Please check the output of /path/to/phan --help. phan path: ${config.phanScriptPath}`)
	}
}

const createLanguageClient = (config: Config, phanRootPath: string) => {
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{
				scheme: "file",
				language: "php"
			}
		],
		uriConverters: {
			// VS Code by default %-encodes even the colon after the drive letter
			// NodeJS handles it much better
			code2Protocol: uri => url.format(url.parse(uri.toString(true))),
			protocol2Code: str => vscode.Uri.parse(str)
		},
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher("**/.phan/config.php")
		}
	}

	const serverOptions = async () => {
		const exists = await fs.promises.access(`${phanRootPath}/.phan/config.php`, fs.constants.F_OK).then(_ => true).catch(_ => false)

		const args = [
			... exists ? [] : ["--directory", "."]
		]

		switch (process.platform) {
			case "win32": {
				return await newServerWithTcpIp({ config, args, cwd: phanRootPath })
			}
			default: {
				return await newServerWithStdio({ config, args, cwd: phanRootPath })
			}
		}
	}

	return new LanguageClient("PHP Language Server (Phan)", serverOptions, clientOptions)
}

const newServerWithTcpIp = (input: {
	config: Config
	args: string[]
	cwd: string
}) => {
	return new Promise<StreamInfo>((resolve, reject) => {
		const server = net.createServer(socket => {
			console.log("PHP process connected")

			socket.on("end", () => {
				console.log("PHP process disconnected")
			})

			server.close()

			resolve({ reader: socket, writer: socket })
		})

		server.listen(0, "127.0.0.1", () => {
			let address = server.address()

			if (! address) {
				return
			}

			if (typeof address !== "string") {
				address = `127.0.0.1:${address.port}`
			}

			newServer({
				... input,
				args: [
					... input.args,
					`--language-server-tcp-connect=${address}`
				]
			})
		})
	})
}

const newServerWithStdio = async (input: {
	config: Config
	args: string[]
	cwd: string
}) => {
	return await newServer({
		... input,
		args: [
			... input.args,
			"--language-server-on-stdin"
		]
	})
}

const newServer = async (input: {
	config: Config
	args: string[]
	cwd: string
}) => {
	const args = [
		input.config.phanScriptPath,
		... input.args,
		"--allow-polyfill-parser",
		... input.config.enableGoToDefinition ? [] : [
			"--language-server-disable-go-to-definition"
		],
		... input.config.enableHover ? [] : [
			"--language-server-disable-hover"
		],
		... input.config.enableCompletion ? [ "--language-server-completion-vscode" ] : [
			"--language-server-disable-completion"
		],
		... ! input.config.enableDebugLog ? [] : [
			"--language-server-verbose"
		],
		... ! input.config.unusedVariableDetection ? [] : [
			"--unused-variable-detection"
		],
		... ! input.config.redundantConditionDetection ? [] : [
			"--redundant-condition-detection"
		],
		... input.config.phanArgs
	]

	console.log("starting PHP Language Server (Phan)", input.config.phpExecutablePath, args, input.cwd)

	const newProcess = childProcess.spawn(input.config.phpExecutablePath, args, {cwd: input.cwd})

	newProcess.stderr.on("data", (chunk: Buffer) => {
		console.error(chunk + "")
	})

	if (input.config.enableDebugLog) {
		newProcess.stdout.on("data", (chunk: Buffer) => {
			console.log(chunk + "")
		})
	}

	return newProcess
}
