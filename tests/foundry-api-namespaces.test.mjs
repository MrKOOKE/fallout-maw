import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

function collectModules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectModules(filePath);
    return entry.isFile() && filePath.endsWith(".mjs") ? [filePath] : [];
  });
}

test("TextEditor calls use the Foundry V14 namespaced implementation", () => {
  const violations = [];
  for (const filePath of collectModules(SRC)) {
    const source = fs.readFileSync(filePath, "utf8");
    const relativePath = path.relative(ROOT, filePath);

    if (/globalThis\.TextEditor|foundry\.applications\.ux\.TextEditor\?\.implementation/.test(source)) {
      violations.push(`${relativePath}: legacy TextEditor fallback`);
    }

    const usesBareTextEditor = /(?<![\w.])TextEditor\./.test(source);
    const declaresNamespacedTextEditor = /\b(?:const|let|var)\s+TextEditor\s*=\s*foundry\.applications\.ux\.TextEditor\.implementation\b/.test(source);
    if (usesBareTextEditor && !declaresNamespacedTextEditor) {
      violations.push(`${relativePath}: unbound global TextEditor call`);
    }
  }

  assert.deepEqual(violations, []);
});

test("other moved application APIs do not fall back to deprecated globals", () => {
  const violations = [];
  for (const filePath of collectModules(SRC)) {
    const source = fs.readFileSync(filePath, "utf8");
    const relativePath = path.relative(ROOT, filePath);

    if (/globalThis\.(?:FilePicker|FormDataExtended|renderTemplate)\b|globalThis\.CONFIG\?\.ux\?\.FilePicker|globalThis\.foundry\?\.applications\?\.apps\?\.FilePicker/.test(source)) {
      violations.push(`${relativePath}: legacy application API fallback`);
    }

    const usesBareFormData = /\bnew\s+FormDataExtended\s*\(/.test(source);
    const declaresNamespacedFormData = /\bconst\s+(?:FormDataExtended\s*=|\{[^}]*\bFormDataExtended\b[^}]*\}\s*=)\s*foundry\.applications\.ux(?:\.FormDataExtended)?\b/s.test(source);
    if (usesBareFormData && !declaresNamespacedFormData) {
      violations.push(`${relativePath}: unbound global FormDataExtended call`);
    }

    const usesBareFilePicker = /(?<![\w.])(?:new\s+)?FilePicker(?:\s*\(|\.)/.test(source);
    const declaresNamespacedFilePicker = /\bconst\s+FilePicker\s*=\s*foundry\.applications\.apps\.FilePicker\.implementation\b/.test(source);
    if (usesBareFilePicker && !declaresNamespacedFilePicker) {
      violations.push(`${relativePath}: unbound global FilePicker call`);
    }

    const usesBareRenderTemplate = /(?<![\w.])renderTemplate\s*\(/.test(source);
    const declaresNamespacedRenderTemplate = /\bconst\s+(?:renderTemplate\s*=\s*foundry\.applications\.handlebars\.renderTemplate|\{[^}]*\brenderTemplate\b[^}]*\}\s*=\s*foundry\.applications\.handlebars)\b/s.test(source);
    if (usesBareRenderTemplate && !declaresNamespacedRenderTemplate) {
      violations.push(`${relativePath}: unbound global renderTemplate call`);
    }
  }

  assert.deepEqual(violations, []);
});
