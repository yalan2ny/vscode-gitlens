import type { TextEditor, Uri } from 'vscode';
import { ProgressLocation } from 'vscode';
import type { Container } from '../container';
import { GitUri } from '../git/gitUri';
import type { GitCommit } from '../git/models/commit';
import { isStash } from '../git/models/commit';
import { showGenericErrorMessage } from '../messages';
import type { AIExplainSource } from '../plus/ai/aiProviderService';
import { showCommitPicker } from '../quickpicks/commitPicker';
import { getBestRepositoryOrShowPicker } from '../quickpicks/repositoryPicker';
import { command } from '../system/-webview/command';
import { showMarkdownPreview } from '../system/-webview/markdown';
import { createMarkdownCommandLink } from '../system/commands';
import { Logger } from '../system/logger';
import { getNodeRepoPath } from '../views/nodes/abstract/viewNode';
import { GlCommandBase } from './commandBase';
import { getCommandUri } from './commandBase.utils';
import type { CommandContext } from './commandContext';
import { isCommandContextViewNodeHasCommit } from './commandContext.utils';

export interface ExplainCommitCommandArgs {
	repoPath?: string | Uri;
	rev?: string;
	source?: AIExplainSource;
}

@command()
export class ExplainCommitCommand extends GlCommandBase {
	static createMarkdownCommandLink(args: ExplainCommitCommandArgs): string {
		return createMarkdownCommandLink<ExplainCommitCommandArgs>('gitlens.ai.explainCommit:editor', args);
	}

	constructor(private readonly container: Container) {
		super(['gitlens.ai.explainCommit', 'gitlens.ai.explainCommit:editor', 'gitlens.ai.explainCommit:views']);
	}

	protected override preExecute(context: CommandContext, args?: ExplainCommitCommandArgs): Promise<void> {
		// Check if the command is being called from a CommitNode
		if (isCommandContextViewNodeHasCommit(context)) {
			args = { ...args };
			args.repoPath = args.repoPath ?? getNodeRepoPath(context.node);
			args.rev = args.rev ?? context.node.commit.sha;
			args.source = args.source ?? {
				source: 'view',
				type: isStash(context.node.commit) ? 'stash' : 'commit',
			};
		}

		return this.execute(context.editor, context.uri, args);
	}

	async execute(editor?: TextEditor, uri?: Uri, args?: ExplainCommitCommandArgs): Promise<void> {
		args = { ...args };

		let repository;
		if (args?.repoPath != null) {
			repository = this.container.git.getRepository(args.repoPath);
		}

		if (repository == null) {
			uri = getCommandUri(uri, editor);
			const gitUri = uri != null ? await GitUri.fromUri(uri) : undefined;
			repository = await getBestRepositoryOrShowPicker(
				gitUri,
				editor,
				'Explain Commit Changes',
				'Choose which repository to explain a commit from',
			);
		}

		if (repository == null) return;

		try {
			let commit: GitCommit | undefined;
			if (args.rev == null) {
				const commitsProvider = repository.git.commits;
				const log = await commitsProvider.getLog();
				const pick = await showCommitPicker(log, 'Explain Commit Changes', 'Choose a commit to explain');
				if (pick?.sha == null) return;
				args.rev = pick.sha;
				commit = pick;
			} else {
				// Get the commit
				commit = await repository.git.commits.getCommit(args.rev);
				if (commit == null) {
					void showGenericErrorMessage('Unable to find the specified commit');
					return;
				}
			}

			// Call the AI service to explain the commit
			const result = await this.container.ai.explainCommit(
				commit,
				{
					...args.source,
					source: args.source?.source ?? 'commandPalette',
					type: 'commit',
				},
				{
					progress: { location: ProgressLocation.Notification, title: 'Explaining commit...' },
				},
			);

			if (result == null) {
				void showGenericErrorMessage('No changes found to explain for commit');
				return;
			}

			// Display the result
			const content = `# Commit Summary\n\n> Generated by ${result.model.name}\n\n## ${commit.summary} (${commit.shortSha})\n\n${result.parsed.summary}\n\n${result.parsed.body}`;

			void showMarkdownPreview(content);
		} catch (ex) {
			Logger.error(ex, 'ExplainCommitCommand', 'execute');
			void showGenericErrorMessage('Unable to explain commit');
		}
	}
}
