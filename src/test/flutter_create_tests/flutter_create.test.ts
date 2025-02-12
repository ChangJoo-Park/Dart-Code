import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vs from "vscode";
import { dartCodeExtensionIdentifier } from "../../shared/constants";
import { LogCategory } from "../../shared/enums";
import { internalApiSymbol } from "../../shared/symbols";
import { InternalExtensionApi } from "../../shared/vscode/interfaces";
import { fsPath } from "../../shared/vscode/utils";
import { activate, extApi, logger, waitForResult } from "../helpers";

describe("flutter", () => {
	beforeEach("activate", () => activate());

	it("created a basic default project", async () => {
		const basicProjectFolder = fsPath(vs.workspace.workspaceFolders![0].uri);
		const expectedString = "title: 'Flutter Demo'";
		const mainFile = path.join(basicProjectFolder, "lib", "main.dart");
		// Creating the sample may be a little slow, so allow up to 60 seconds for it.
		logger.info("Waiting for file to exist", LogCategory.CI);
		await waitForResult(() => fs.existsSync(mainFile), "lib/main.dart did not exist", 100000);
		// Wait for up to 10 seconds for the content to match, as the file may be updated after creation.
		logger.info("Waiting for content match", LogCategory.CI);
		await waitForResult(() => {
			const contents = fs.readFileSync(mainFile);
			return contents.indexOf(expectedString) !== -1;
		}, undefined, 10000, false); // Don't throw on failure, as we have a better assert below that can include the contents.

		const contents = fs.readFileSync(mainFile);
		if (contents.indexOf(expectedString) === -1)
			assert.fail(`Did not find "${expectedString}'" in the sample file:\n\n${contents}`);
	});

	it("created a sample project", async function () {
		if (!extApi.flutterCapabilities.supportsMultipleSamplesPerElement) {
			this.skip();
			return;
		}

		const sampleProjectFolder = fsPath(vs.workspace.workspaceFolders![1].uri);
		const expectedString = "Flutter code sample for material.IconButton.1";
		const mainFile = path.join(sampleProjectFolder, "lib", "main.dart");
		// Creating the sample may be a little slow, so allow up to 60 seconds for it.
		logger.info("Waiting for file to exist", LogCategory.CI);
		await waitForResult(() => fs.existsSync(mainFile), "lib/main.dart did not exist", 100000);
		// Wait for up to 10 seconds for the content to match, as the file may be updated after creation.
		logger.info("Waiting for content match", LogCategory.CI);
		await waitForResult(() => {
			const contents = fs.readFileSync(mainFile);
			return contents.indexOf(expectedString) !== -1;
		}, undefined, 10000, false); // Don't throw on failure, as we have a better assert below that can include the contents.

		const contents = fs.readFileSync(mainFile);
		if (contents.indexOf(expectedString) === -1)
			assert.fail(`Did not find "${expectedString}'" in the sample file:\n\n${contents}`);
	});

	it("triggered Flutter mode", () => {
		const ext = vs.extensions.getExtension(dartCodeExtensionIdentifier);
		assert.ok(ext);
		assert.ok(ext.isActive);
		const api: InternalExtensionApi = ext.exports[internalApiSymbol];
		assert.equal(api.workspaceContext.hasAnyFlutterProjects, true);
	});
});
