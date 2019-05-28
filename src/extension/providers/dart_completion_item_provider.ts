import * as path from "path";
import * as vs from "vscode";
import { CancellationToken, CompletionContext, CompletionItem, CompletionItemKind, CompletionItemProvider, CompletionList, CompletionTriggerKind, Disposable, MarkdownString, Position, SnippetString, TextDocument } from "vscode";
import { flatMap } from "../../shared/utils";
import { fsPath } from "../../shared/vscode/utils";
import * as as from "../analysis/analysis_server_types";
import { Analyzer } from "../analysis/analyzer";
import { hasOverlappingEdits } from "../commands/edit";
import { config } from "../config";
import { cleanDartdoc } from "../dartdocs";
import { IAmDisposable } from "../debug/utils";
import { logError, logWarn } from "../utils/log";

export class FakeCompletionItemProvider implements CompletionItemProvider {
	public async provideCompletionItems(
		document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext,
	): Promise<CompletionList> {

		const items: CompletionItem[] = Array<CompletionItem>(20000);
		for (let i = 0; i < items.length; i++) {
			const item = new CompletionItem(`Item ${i}`);
			item.filterText = `${item.label}???`;
			item.kind = CompletionItemKind.Constant;
			item.detail = "(deprecated)";
			item.documentation = "docs";
			item.insertText = `${item.label} !!`;
			item.keepWhitespace = true;
			item.commitCharacters = ["["];

			item.command = {
				command: "editor.action.triggerSuggest",
				title: "Suggest",
			};
			items[i] = item;
		}
		return new CompletionList(items);
	}

	public async resolveCompletionItem(item: DelayedCompletionItem, token: CancellationToken): Promise<CompletionItem | undefined> {
		return undefined;
	}
}

export class DartCompletionItemProvider implements CompletionItemProvider, IAmDisposable {
	private disposables: Disposable[] = [];
	private cachedSuggestions: { [key: number]: CachedSuggestionSet } = {};

	constructor(private readonly analyzer: Analyzer) {
		this.disposables.push(analyzer.registerForCompletionAvailableSuggestions((n) => this.storeCompletionSuggestions(n)));
	}

	public async provideCompletionItems(
		document: TextDocument, position: Position, token: CancellationToken, context: CompletionContext,
	): Promise<CompletionList> {
		const line = document.lineAt(position.line).text.slice(0, position.character);
		const conf = config.for(document.uri);
		const enableCommitCharacters = conf.enableCompletionCommitCharacters;

		if (!this.shouldAllowCompletion(line, context))
			return;

		const resp = await this.analyzer.completionGetSuggestionsResults({
			file: fsPath(document.uri),
			offset: document.offsetAt(position),
		});

		const replacementRange = new vs.Range(
			document.positionAt(resp.replacementOffset),
			document.positionAt(resp.replacementOffset + resp.replacementLength),
		);

		const includedResults = resp.results.map((r) => this.convertResult(enableCommitCharacters, replacementRange, r));
		const cachedResults = this.getCachedResults(document, enableCommitCharacters, document.offsetAt(position), resp);

		const allResults = [...includedResults, ...cachedResults];

		console.log(allResults.length);
		return new CompletionList(allResults);
	}

	private shouldAllowCompletion(line: string, context: CompletionContext): boolean {
		line = line.trim();
		// Filter out auto triggered completions on certain characters based on the previous
		// characters (eg. to allow completion on " if it's part of an import).
		if (context.triggerKind === CompletionTriggerKind.TriggerCharacter) {
			switch (context.triggerCharacter) {
				case "{":
					return line.endsWith("${");
				case "'":
					return line.endsWith("import '") || line.endsWith("export '");
				case "\"":
					return line.endsWith("import \"") || line.endsWith("export \"");
				case "/":
				case "\\":
					return line.startsWith("import \"") || line.startsWith("export \"")
						|| line.startsWith("import '") || line.startsWith("export '");
			}
		}

		// Otherwise, allow through.
		return true;
	}

	private storeCompletionSuggestions(notification: as.CompletionAvailableSuggestionsNotification) {
		if (notification.changedLibraries) {
			for (const completionSet of notification.changedLibraries) {
				const items: SuggestSetsByElementKind = {};
				completionSet.items.forEach((item) => {
					if (!items[item.element.kind])
						items[item.element.kind] = [];
					items[item.element.kind].push(item);
				});
				this.cachedSuggestions[completionSet.id] = new CachedSuggestionSet(completionSet.id, completionSet.uri, items);
			}
		}
		if (notification.removedLibraries) {
			for (const completionSetID of notification.removedLibraries) {
				delete this.cachedSuggestions[completionSetID];
			}
		}
	}

	public async resolveCompletionItem?(item: DelayedCompletionItem, token: CancellationToken): Promise<CompletionItem> {
		if (!item.suggestion)
			return;

		const res = await this.analyzer.completionGetSuggestionDetails({
			file: item.filePath,
			id: item.suggestionSetID,
			label: item.label,
			offset: item.offset,
		});

		if (token.isCancellationRequested)
			return item;

		const selectionOffset = res.change && res.change.selection ? res.change.selection.offset : undefined;
		const selectionLength = res.change && res.change.selection ? 0 : undefined;

		// Rebuild the completion using the additional resolved info.
		let label = res.completion;

		// If we have trailing commas (flutter) they look weird in the list, so trim the off (for display label only).
		if (label.endsWith(","))
			label = label.substr(0, label.length - 1).trim();

		item.label = label;
		item.insertText = this.makeCompletionSnippet(label, selectionOffset, selectionLength);

		// Additional edits for the imports.
		if (res && res.change && res.change.edits && res.change.edits.length) {
			appendAdditionalEdits(item, item.document, res.change);
		}

		return item;
	}

	private getCachedResults(
		document: TextDocument,
		enableCommitCharacters: boolean,
		offset: number,
		resp: as.CompletionResultsNotification,
	): CompletionItem[] {
		if (!resp.includedSuggestionSets || !resp.includedElementKinds)
			return [];

		// Create a fast lookup for relevance boosts based on tag string.
		const tagBoosts: { [key: string]: number } = {};
		resp.includedSuggestionRelevanceTags.forEach((r) => tagBoosts[r.tag] = r.relevanceBoost);

		const replacementRange = new vs.Range(
			document.positionAt(resp.replacementOffset),
			document.positionAt(resp.replacementOffset + resp.replacementLength),
		);

		const filePath = fsPath(document.uri);
		const results: DelayedCompletionItem[] = [];
		for (const includedSuggestionSet of resp.includedSuggestionSets) {
			const suggestionSet = this.cachedSuggestions[includedSuggestionSet.id];
			if (!suggestionSet) {
				logWarn(`Suggestion set ${includedSuggestionSet.id} was not available and therefore not included in the completion results`);
				return [];
			}

			for (const kind of resp.includedElementKinds) {
				const suggestions = suggestionSet.itemsByKind[kind] || [];
				const setResults = suggestions.map((suggestion, i) => {
					// If this item has not already been cached, convert it into a
					// cached suggestion and put it back into the list. This will
					// avoid us doing this work in future requests that request
					// the same item.
					if (!(suggestion instanceof CachedSuggestion)) {
						suggestion = new CachedSuggestion(
							this.makePartialCompletionItem(
								enableCommitCharacters,
								suggestion.label,
								suggestion.docSummary,
								suggestion.element ? suggestion.element.kind : undefined,
								false,
								undefined,
								suggestion.element ? suggestion.element.parameters : undefined,
								undefined,
								suggestion.element ? suggestion.element.returnType : undefined,
							),
							suggestion.relevanceTags,
						);
						// Stash this one back in the cache for next time we need it.
						suggestions[i] = suggestion;
					}

					// Calculate the relevance for this item.
					let relevance = includedSuggestionSet.relevance;
					if (suggestion.relevanceTags)
						suggestion.relevanceTags.forEach((t) => relevance += (tagBoosts[t] || 0));

					// TODO: includedSuggestionSet.displayUri || suggestionSet.uri ??
					const completionItem = this.populateCompletionItem(
						suggestion.partialCompletionItem,
						undefined, // This is only used when there's no element (eg. keyword completions) that won't happen here.
						relevance,
						replacementRange,
						0,
						0,
					);

					// failed?
					// completionItem.document = document;
					// completionItem.filePath = filePath;
					// completionItem.offset = offset;
					// completionItem.suggestion = suggestion;
					// completionItem.suggestionSetID = includedSuggestionSet.id;
					// return completionItem;

					// Add additional info that resolve will need.
					return {
						...completionItem,
						document,
						filePath,
						offset,
						suggestion,
						suggestionSetID: includedSuggestionSet.id,
					};
				});

				results.push(...setResults);
			}
		}

		return results;
	}

	private convertResult(
		enableCommitCharacters: boolean,
		replacementRange: vs.Range,
		suggestion: as.CompletionSuggestion,
	): CompletionItem {
		return this.makeCompletionItem(
			enableCommitCharacters,
			suggestion.displayText || suggestion.completion,
			suggestion.docSummary,
			suggestion.element ? suggestion.element.kind : undefined,
			suggestion.isDeprecated,
			suggestion.kind,
			suggestion.element ? suggestion.element.parameters : undefined,
			suggestion.parameterType,
			suggestion.relevance,
			replacementRange,
			suggestion.returnType,
			suggestion.selectionLength,
			suggestion.selectionOffset,
		);
	}

	private makePartialCompletionItem(
		enableCommitCharacters: boolean,
		label: string,
		docSummary: string | undefined,
		elementKind: as.ElementKind | undefined,
		isDeprecated: boolean,
		kind: as.CompletionSuggestionKind | undefined,
		parameters: string | undefined,
		parameterType: string | undefined,
		returnType: string | undefined,
	): CompletionItem {
		const completionItemKind = elementKind ? this.getElementKind(elementKind) : undefined;
		let detail = "";
		let triggerCompletion = false;

		if (parameters && completionItemKind !== CompletionItemKind.Property && kind !== "OVERRIDE"
			// Don't ever show if there is already a paren! (#969).
			&& label.indexOf("(") === -1
		) {
			label += parameters.length === 2 ? "()" : "(…)";
			detail = parameters;
		}

		// If we're a property, work out the type.
		if (completionItemKind === CompletionItemKind.Property) {
			// Setters appear as methods with one arg (and cause getters to not appear),
			// so treat them both the same and just display with the properties type.
			detail = elementKind === "GETTER"
				? returnType
				// See https://github.com/dart-lang/sdk/issues/27747
				: parameters ? parameters.substring(1, parameters.lastIndexOf(" ")) : "";
			// Otherwise, get return type from method.
		} else if (returnType) {
			detail =
				detail === ""
					? returnType
					: detail + " → " + returnType;
		} else if (parameterType) {
			detail = parameterType;
		}

		// If we have trailing commas (flutter) they look weird in the list, so trim the off (for display label only).
		if (label.endsWith(","))
			label = label.substr(0, label.length - 1).trim();

		// If we didnt have a CompletionItemKind from our element, base it on the CompletionSuggestionKind.
		// This covers things like Keywords that don't have elements.
		const completionKind = completionItemKind || (kind ? this.getSuggestionKind(kind, label) : undefined);

		const completion = new CompletionItem(label, completionKind);
		completion.label = label;
		completion.filterText = label.split("(")[0]; // Don't ever include anything after a ( in filtering.
		completion.kind = completionKind;
		completion.detail = (isDeprecated ? "(deprecated) " : "") + detail;
		completion.documentation = new MarkdownString(cleanDartdoc(docSummary));
		completion.insertText = label;
		completion.keepWhitespace = true;
		if (enableCommitCharacters)
			completion.commitCharacters = this.getCommitCharacters(kind);

		const triggerCompletionsFor = ["import '';"];
		if (triggerCompletionsFor.indexOf(label) !== -1)
			triggerCompletion = true;

		// Handle folders in imports better.
		if (kind === "IMPORT" && label.endsWith("/"))
			triggerCompletion = true;

		if (triggerCompletion) {
			completion.command = {
				command: "editor.action.triggerSuggest",
				title: "Suggest",
			};
		}

		return completion;
	}

	private makeCompletionItem(
		enableCommitCharacters: boolean,
		label: string,
		docSummary: string | undefined,
		elementKind: as.ElementKind | undefined,
		isDeprecated: boolean,
		kind: as.CompletionSuggestionKind | undefined,
		parameters: string | undefined,
		parameterType: string | undefined,
		relevance: number,
		range: vs.Range,
		returnType: string | undefined,
		selectionLength: number,
		selectionOffset: number,
	): CompletionItem {
		const completion = this.makePartialCompletionItem(
			enableCommitCharacters,
			label,
			docSummary,
			elementKind,
			isDeprecated,
			kind,
			parameters,
			parameterType,
			returnType,
		);
		return this.populateCompletionItem(
			completion,
			kind,
			relevance,
			range,
			selectionLength,
			selectionOffset,
		);
	}

	private populateCompletionItem(
		completion: CompletionItem,
		kind: as.CompletionSuggestionKind | undefined,
		relevance: number,
		replacementRange: vs.Range,
		selectionLength: number,
		selectionOffset: number,
	): CompletionItem {
		completion.insertText = this.makeCompletionSnippet(completion.label, selectionOffset, selectionLength);
		completion.range = replacementRange;

		let triggerCompletion = false;
		const triggerCompletionsFor = ["import '';"];
		if (triggerCompletionsFor.indexOf(completion.label) !== -1)
			triggerCompletion = true;
		// Handle folders in imports better.
		if (kind === "IMPORT" && completion.label.endsWith("/"))
			triggerCompletion = true;

		if (triggerCompletion) {
			completion.command = {
				command: "editor.action.triggerSuggest",
				title: "Suggest",
			};
		} else {
			// Null this out in case it was set on the previous use of this completion item.
			completion.command = undefined;
		}

		// Relevance is a number, highest being best. Code sorts by text, so subtract from a large number so that
		// a text sort will result in the correct order.
		// 555 -> 999455
		//  10 -> 999990
		//   1 -> 999999
		completion.sortText = (1000000 - relevance).toString() + completion.label;
		return completion;
	}

	private makeCompletionSnippet(text: string, selectionOffset: number, selectionLength: number) {
		const completionText = new SnippetString();
		if (selectionOffset > 0) {
			const before = text.slice(0, selectionOffset);
			const selection = text.slice(selectionOffset, selectionOffset + selectionLength);
			const after = text.slice(selectionOffset + selectionLength);
			completionText.appendText(before);
			if (selection)
				completionText.appendPlaceholder(selection);
			else
				completionText.appendTabstop(0);
			completionText.appendText(after);
		} else {
			completionText.appendText(text);
		}
		return completionText;
	}

	private getSuggestionKind(kind: as.CompletionSuggestionKind, label: string): CompletionItemKind {
		switch (kind) {
			case "ARGUMENT_LIST":
				return CompletionItemKind.Variable;
			case "IMPORT":
				return label.startsWith("dart:")
					? CompletionItemKind.Module
					: path.extname(label.toLowerCase()) === ".dart"
						? CompletionItemKind.File
						: CompletionItemKind.Folder;
			case "IDENTIFIER":
				return CompletionItemKind.Variable;
			case "INVOCATION":
				return CompletionItemKind.Method;
			case "KEYWORD":
				return CompletionItemKind.Keyword;
			case "NAMED_ARGUMENT":
				return CompletionItemKind.Variable;
			case "OPTIONAL_ARGUMENT":
				return CompletionItemKind.Variable;
			case "PARAMETER":
				return CompletionItemKind.Value;
		}
	}

	private getElementKind(kind: as.ElementKind): CompletionItemKind {
		switch (kind) {
			case "CLASS":
			case "CLASS_TYPE_ALIAS":
				return CompletionItemKind.Class;
			case "COMPILATION_UNIT":
				return CompletionItemKind.Module;
			case "CONSTRUCTOR":
			case "CONSTRUCTOR_INVOCATION":
				return CompletionItemKind.Constructor;
			case "ENUM":
				return CompletionItemKind.Enum;
			case "ENUM_CONSTANT":
				return CompletionItemKind.EnumMember;
			case "FIELD":
				return CompletionItemKind.Field;
			case "FILE":
				return CompletionItemKind.File;
			case "FUNCTION":
			case "FUNCTION_TYPE_ALIAS":
				return CompletionItemKind.Function;
			case "GETTER":
				return CompletionItemKind.Property;
			case "LABEL":
			case "LIBRARY":
				return CompletionItemKind.Module;
			case "LOCAL_VARIABLE":
				return CompletionItemKind.Variable;
			case "METHOD":
				return CompletionItemKind.Method;
			case "PARAMETER":
			case "PREFIX":
				return CompletionItemKind.Variable;
			case "SETTER":
				return CompletionItemKind.Property;
			case "TOP_LEVEL_VARIABLE":
			case "TYPE_PARAMETER":
				return CompletionItemKind.Variable;
			case "UNIT_TEST_GROUP":
				return CompletionItemKind.Module;
			case "UNIT_TEST_TEST":
				return CompletionItemKind.Method;
			case "UNKNOWN":
				return CompletionItemKind.Value;
		}
	}

	private getCommitCharacters(kind: as.CompletionSuggestionKind): string[] {
		switch (kind) {
			case "IDENTIFIER":
			case "INVOCATION":
				return [".", ",", "(", "["];
		}
	}

	public dispose(): any {
		this.disposables.forEach((d) => d.dispose());
	}
}

export interface DelayedCompletionItem extends CompletionItem {
	document: TextDocument;
	filePath: string;
	offset: number;
	suggestion: CachedSuggestion;
	suggestionSetID: number;
}

function appendAdditionalEdits(completionItem: vs.CompletionItem, document: vs.TextDocument, change: as.SourceChange | undefined): void {
	if (!change)
		return undefined;

	// VS Code expects offsets to be based on the original document, but the analysis server provides
	// them assuming all previous edits have already been made. This means if the server provides us a
	// set of edits where any edits offset is *equal to or greater than* a previous edit, it will do the wrong thing.
	// If this happens; we will fall back to sequential edits and write a warning.
	const hasProblematicEdits = hasOverlappingEdits(change);

	if (hasProblematicEdits) {
		logError("Unable to insert imports because of overlapping edits from the server.");
		vs.window.showErrorMessage(`Unable to insert imports because of overlapping edits from the server`);
		return undefined;
	}

	const filePath = fsPath(document.uri);
	const thisFilesEdits = change.edits.filter((e) => e.file === filePath);
	const otherFilesEdits = change.edits.filter((e) => e.file !== filePath);

	if (thisFilesEdits.length) {
		completionItem.additionalTextEdits = flatMap(thisFilesEdits, (edit) => {
			return edit.edits.map((edit) => {
				const range = new vs.Range(
					document.positionAt(edit.offset),
					document.positionAt(edit.offset + edit.length),
				);
				return new vs.TextEdit(range, edit.replacement);
			});
		});
	}
	if (otherFilesEdits.length) {
		const filteredSourceChange: as.SourceChange = {
			edits: otherFilesEdits,
			id: change.id,
			linkedEditGroups: undefined,
			message: change.message,
			selection: change.selection,
		};
		completionItem.command = {
			arguments: [document, filteredSourceChange],
			command: "_dart.applySourceChange",
			title: "Automatically add imports",
		};
	}
}

class CachedSuggestionSet {
	constructor(
		public readonly id: number,
		public readonly uri: string,
		public readonly itemsByKind: SuggestSetsByElementKind,
	) { }
}

type AvailableOrCachedSuggestion = as.AvailableSuggestion | CachedSuggestion;
type SuggestSetsByElementKind = { [key in as.ElementKind]?: AvailableOrCachedSuggestion[] };

class CachedSuggestion {
	constructor(
		public readonly partialCompletionItem: CompletionItem,
		public readonly relevanceTags: string[] | undefined,
	) { }
}
