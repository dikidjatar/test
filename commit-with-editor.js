// file: commit-with-editor.js
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import git from 'isomorphic-git';

const fsBinding = fs;

// determine editor command (returns [cmd, ...args])
function editorCommandForEnv() {
  const envEditor = process.env.GIT_EDITOR || process.env.VISUAL || process.env.EDITOR;
  if (envEditor) {
    // split simple: jika env berisi args (mis. "code --wait"), split by spasi
    const parts = envEditor.split(' ').filter(Boolean);
    // ensure --wait for VS Code if not present
    if ((parts[0] === 'code' || parts[0].endsWith('code')) && !parts.includes('--wait')) {
      parts.push('--wait');
    }
    return parts;
  }
  if (process.platform === 'win32') return ['notepad'];
  return ['vi'];
}

// open editor and wait until closed
function openEditorAndWait(cmdParts, filePath) {
  const [cmd, ...args] = cmdParts;
  const finalArgs = args.concat([filePath]);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, finalArgs, { stdio: 'inherit', shell: false });

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      // many editors return 0; some GUI editors return non-zero — still resolve
      resolve(code);
    });
  });
}

// helper: create commit template with comments and staged file list
async function createCommitTemplate(dir, commitFilePath) {
  // get staged files via statusMatrix (isomorphic-git)
  // statusMatrix entries: [filepath, HEAD, WORKDIR, STAGE]
  let stagedFiles = [];
  try {
    const matrix = await git.statusMatrix({ fs: fsBinding, dir });
    stagedFiles = matrix
      .filter(([file, head, workdir, stage]) => stage !== 0) // staged in index
      .map(([file]) => file);
  } catch (e) {
    // ignore errors, stagedFiles stay empty
    stagedFiles = [];
  }

  const lines = [];
  lines.push(''); // blank line for message summary
  lines.push('# Please enter the commit message for your changes. Lines starting');
  lines.push('# with \'#\' will be ignored, and an empty message aborts the commit.');
  lines.push(`# On branch ${await (git.currentBranch({ fs: fsBinding, dir, fullname: false }).catch(()=> 'unknown'))}`);
  lines.push('# Changes to be committed:');
  if (stagedFiles.length === 0) {
    lines.push('#   (no changes staged)');
  } else {
    for (const f of stagedFiles) lines.push(`#   ${f}`);
  }

  await fs.promises.writeFile(commitFilePath, lines.join('\n'), { encoding: 'utf8' });
}

// parse file: remove comment lines (starting with '#') and trim
function parseCommitMessage(raw) {
  const lines = raw.split(/\r?\n/);
  const contentLines = lines.filter(l => !l.startsWith('#'));
  // remove leading/trailing blank lines
  while (contentLines.length && contentLines[0].trim() === '') contentLines.shift();
  while (contentLines.length && contentLines[contentLines.length - 1].trim() === '') contentLines.pop();
  return contentLines.join('\n').trim();
}

// main function
export async function commitWithEditor({ dir, gitdir = path.join(dir, '.git'), message }) {
  // if message provided, direct commit
  if (message && message.trim().length > 0) {
    return git.commit({
      fs: fsBinding,
      dir,
      gitdir,
      message,
      author: {
        name: (await git.getConfig({ fs: fsBinding, dir, path: 'user.name' })) || 'Unknown',
        email: (await git.getConfig({ fs: fsBinding, dir, path: 'user.email' })) || 'unknown@example.com',
      },
    });
  }

  // else: create .git/COMMIT_EDITMSG and open editor
  const commitFilePath = path.join(gitdir, 'COMMIT_EDITMSG');

  // ensure gitdir exists
  await fs.promises.mkdir(gitdir, { recursive: true });

  // create template (you can also pre-fill with previous message)
  await createCommitTemplate(dir, commitFilePath);

  // get editor command
  const cmdParts = editorCommandForEnv();

  // NOTE: for 'code' on windows it might be 'code.cmd' in PATH; spawn will find it
  await openEditorAndWait(cmdParts, commitFilePath);

  // read file
  const raw = await fs.promises.readFile(commitFilePath, 'utf8');
  const parsedMessage = parseCommitMessage(raw);

  if (!parsedMessage) {
    throw new Error('Aborted: empty commit message');
  }

  // optionally leave the COMMIT_EDITMSG file as-is (git does). We'll just reuse it.
  // perform commit
  const oid = await git.commit({
    fs: fsBinding,
    dir,
    gitdir,
    message: parsedMessage,
    author: {
      name: (await git.getConfig({ fs: fsBinding, dir, path: 'user.name' })) || 'Unknown',
      email: (await git.getConfig({ fs: fsBinding, dir, path: 'user.email' })) || 'unknown@example.com',
    },
  });

  return oid; // commit oid
}

// usage example (call from your script):
// import { commitWithEditor } from './commit-with-editor.js';
// (async () => {
//   try {
//     const oid = await commitWithEditor({ dir: '/path/to/repo' });
//     console.log('Committed', oid);
//   } catch (err) {
//     console.error('Commit failed:', err.message);
//   }
// })();