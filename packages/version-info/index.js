import { existsSync, readFileSync }  from 'node:fs';
import { join, parse } from 'node:path';
import { cwd }         from 'node:process';
import { readFile }    from 'node:fs/promises';

const findFile = (file) => {
    let dir = cwd();

    while (dir !== parse(dir).root) {
        if (existsSync(join(dir, file))) {
            return dir;
        }

        dir = join(dir, '../');
    }
}

const root = findFile('.git');
const pack = findFile('package.json');
const packageMeta = pack ? JSON.parse(readFileSync(join(pack, 'package.json'), 'utf8')) : {};

const safeReadGit = async (filename) => {
    if (!root) {
        return;
    }

    try {
        return await readFile(join(root, filename), 'utf8');
    } catch {
        return;
    }
};

const readGit = (filename) => {
    if (!root) {
        return;
    }

    return readFile(join(root, filename), 'utf8');
}

export const getCommit = async () => {
    if (process.env.CI_COMMIT_SHA) {
        return process.env.CI_COMMIT_SHA;
    }

    const logs = await safeReadGit('.git/logs/HEAD');
    return logs
            ?.split('\n')
            ?.filter(String)
            ?.pop()
            ?.split(' ')[1];
}

export const getBranch = async () => {
    if (process.env.CF_PAGES_BRANCH) {
        return process.env.CF_PAGES_BRANCH;
    }

    if (process.env.WORKERS_CI_BRANCH) {
        return process.env.WORKERS_CI_BRANCH;
    }
    const head = await safeReadGit('.git/HEAD');
    return head
            ?.replace(/^ref: refs\/heads\//, '')
            ?.trim();
}

export const getRemote = async () => {
    let remote = (await safeReadGit('.git/config'))
                    ?.split('\n')
                    ?.find(line => line.includes('url = '))
                    ?.split('url = ')[1]
                ?? packageMeta?.repository?.url
                ?? process.env.CI_REPOSITORY_URL;

    if (remote?.startsWith('git@')) {
        remote = remote.split(':')[1];
    } else if (remote?.startsWith('http')) {
        remote = new URL(remote).pathname.substring(1);
    }

    remote = remote?.replace(/\.git$/, '');

    if (!remote) {
        throw 'could not parse remote';
    }

    return remote;
}

export const getVersion = async () => {
    if (!pack) {
        throw 'no package root found';
    }

    const { version } = JSON.parse(
        await readFile(join(pack, 'package.json'), 'utf8')
    );

    return version;
}
