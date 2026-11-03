/**
 * Server-side TypeScript check of the automations workspace.
 * Automations run with transpileOnly, so type errors never block them —
 * this is how the AI (and MCP clients) find them.
 */

import * as fs from "fs";
import * as path from "path";
import type * as TypeScript from "typescript";
import { EntityCatalog, checkEntityLiteral } from "./entity-check";

const MAX_REPORTED_DIAGNOSTICS = 100;
const EXCLUDED_DIRS = ["node_modules", "dist"];

export interface TypeCheckResult {
  fileCount: number;
  errorCount: number;
  warningCount: number;
  unknownEntityCount: number;
  lines: string[];
  truncated: boolean;
}

let typescriptModule: typeof TypeScript | null = null;

/** The compiler is large; load it on the first check instead of at startup. */
function loadTypeScript(): typeof TypeScript {
  if (!typescriptModule) {
    typescriptModule = require("typescript") as typeof TypeScript;
  }
  return typescriptModule;
}

function fallbackOptions(ts: typeof TypeScript): TypeScript.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
  };
}

function findTypeRoots(): string[] {
  try {
    return [path.dirname(path.dirname(require.resolve("@types/node/package.json")))];
  } catch {
    return [];
  }
}

export class TypeChecker {
  private automationsPath: string;
  private typeRoots = findTypeRoots();

  constructor(automationsPath: string) {
    this.automationsPath = path.resolve(automationsPath);
  }

  /**
   * Check every workspace file, or report diagnostics for one file only.
   * With a catalog, string literals that look like unknown entity ids are reported too.
   */
  check(onlyFile?: string, catalog?: EntityCatalog): TypeCheckResult {
    const ts = loadTypeScript();
    const rootNames = this.collectFiles(this.automationsPath);
    const options = this.loadOptions(ts);
    const program = ts.createProgram({ rootNames, options });

    const onlyPath = onlyFile ? path.resolve(this.automationsPath, onlyFile) : undefined;
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
      if (!diagnostic.file) return !onlyPath;
      const fileName = path.resolve(diagnostic.file.fileName);
      if (fileName.includes(`${path.sep}node_modules${path.sep}`)) return false;
      return onlyPath ? fileName === onlyPath : fileName.startsWith(this.automationsPath);
    });

    let errorCount = 0;
    let warningCount = 0;
    const lines: string[] = [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.category === ts.DiagnosticCategory.Error) errorCount++;
      else if (diagnostic.category === ts.DiagnosticCategory.Warning) warningCount++;
      if (lines.length >= MAX_REPORTED_DIAGNOSTICS) continue;

      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n  ");
      const category = ts.DiagnosticCategory[diagnostic.category].toLowerCase();
      if (diagnostic.file && diagnostic.start !== undefined) {
        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        const relative = path.relative(this.automationsPath, diagnostic.file.fileName).split(path.sep).join("/");
        lines.push(`${relative}:${position.line + 1}:${position.character + 1} - ${category} TS${diagnostic.code}: ${message}`);
      } else {
        lines.push(`${category} TS${diagnostic.code}: ${message}`);
      }
    }

    let unknownEntityCount = 0;
    if (catalog && catalog.ids.size > 0) {
      for (const sourceFile of program.getSourceFiles()) {
        const fileName = path.resolve(sourceFile.fileName);
        if (!fileName.startsWith(this.automationsPath) || fileName.includes(`${path.sep}node_modules${path.sep}`)) continue;
        if (onlyPath && fileName !== onlyPath) continue;
        const relative = path.relative(this.automationsPath, fileName).split(path.sep).join("/");
        const visit = (node: TypeScript.Node) => {
          if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
            const problem = checkEntityLiteral(node.text, catalog);
            if (problem) {
              unknownEntityCount++;
              if (lines.length < MAX_REPORTED_DIAGNOSTICS) {
                const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                lines.push(`${relative}:${position.line + 1}:${position.character + 1} - warning: ${problem}`);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);
      }
    }

    return {
      fileCount: rootNames.length,
      errorCount,
      warningCount: warningCount + unknownEntityCount,
      unknownEntityCount,
      lines,
      truncated: diagnostics.length + unknownEntityCount > lines.length,
    };
  }

  private loadOptions(ts: typeof TypeScript): TypeScript.CompilerOptions {
    let options = fallbackOptions(ts);
    const configPath = path.join(this.automationsPath, "tsconfig.json");
    if (fs.existsSync(configPath)) {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, this.automationsPath);
        options = parsed.options;
      }
    }
    options.noEmit = true;
    if (!options.types && !options.typeRoots && this.typeRoots.length > 0) {
      options.typeRoots = this.typeRoots;
      options.types = ["node"];
    }
    return options;
  }

  private collectFiles(dir: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || EXCLUDED_DIRS.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectFiles(fullPath));
      } else if (entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
    return files;
  }
}
