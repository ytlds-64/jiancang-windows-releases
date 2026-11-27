import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareMedia({ app, backend, windows }) {
  const source = await realpath(join(app, 'vendor', 'ocr'));
  const destination = join(backend, 'vendor', 'ocr');
  const manifest = await readFile(join(source, 'manifest.json'));
  const { files } = JSON.parse(manifest);
  const seen = new Set(['manifest.json']);
  await mkdir(destination, { recursive: true });

  for (const [name, digest] of Object.entries(files)) {
    const folded = name.toLowerCase();
    if (isAbsolute(name) || name.split('/').some(part => !part || part === '..' || part === '.') || /[\\:\0]/.test(name) || seen.has(folded)) {
      throw new Error(`Invalid offline OCR dependency path: ${name}`);
    }
    seen.add(folded);
    const file = join(source, name);
    const stat = await lstat(file);
    const resolved = relative(source, await realpath(file));
    if (!stat.isFile() || stat.isSymbolicLink() || isAbsolute(resolved) || resolved.startsWith(`..${sep}`) ||
        createHash('sha256').update(await readFile(file)).digest('hex') !== digest) {
      throw new Error(`Invalid offline OCR dependency: ${name}`);
    }
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
  }
  await copyFile(join(source, 'manifest.json'), join(destination, 'manifest.json'));

  if (windows) {
    const python = process.env.JIANCANG_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const staging = fileURLToPath(new URL('Prepare-Media-FFmpeg.py', import.meta.url));
    execFileSync(python, [staging, join(backend, 'vendor', 'media')], { stdio: 'inherit' });
  }
}
