import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const cwd = fileURLToPath(new URL('../src/', import.meta.url));
const files = globSync('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', {
  cwd,
  exclude: ['**/*.{test,spec}.*', '**/{test,tests,__tests__}/**'],
});
let lines = 0;
for (const file of files) {
  const content = readFileSync(join(cwd, file), 'utf8');
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const codeLines = new Set<number>();
  const pending = [source as ts.Node];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (ts.isJSDoc(node)) continue;
    const children = node.getChildren(source);
    if (children.length > 0) {
      pending.push(...children);
      continue;
    }
    const start = node.getStart(source);
    const firstLine = source.getLineAndCharacterOfPosition(start).line;
    node
      .getText(source)
      .split(/\r\n|\r|\n/)
      .forEach((text, index) => {
        if (text.trim()) codeLines.add(firstLine + index);
      });
  }
  lines += codeLines.size;
}
console.log(
  `src: ${files.length} files, ${lines} code lines (excluding tests, blank lines and comments)`,
);
