"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_CONFIG_BYTES = 4096;

function isRegularFile(filename) {
  try {
    return fs.lstatSync(filename).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function readProjectConfig(filename) {
  if (!isRegularFile(filename)) throw new Error("Invalid configuration file");
  const descriptor = fs.openSync(filename, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error("Invalid configuration file");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (count > MAX_CONFIG_BYTES) throw new Error("Invalid configuration file");
    return JSON.parse(buffer.subarray(0, count).toString("utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveProjectRoot({ isPackaged, resourcesPath, frontendDir }) {
  if (!isPackaged) return path.resolve(frontendDir, "..");
  const portableRoot = findPortableSource(resourcesPath);
  if (portableRoot) return portableRoot;
  try {
    const config = readProjectConfig(path.join(resourcesPath, "noda-project.json"));
    if (!config || typeof config !== "object" || Array.isArray(config)
        || Object.keys(config).length !== 2 || config.schema !== 1
        || typeof config.projectRoot !== "string" || !config.projectRoot
        || config.projectRoot !== config.projectRoot.trim()
        || config.projectRoot.includes("\0") || !path.isAbsolute(config.projectRoot)) {
      throw new Error("Invalid project configuration");
    }
    const root = path.resolve(config.projectRoot);
    const directory = fs.lstatSync(root);
    const python = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
    if (!directory.isDirectory() || directory.isSymbolicLink()
        || !["backend/app_runtime.py", "frontend/package.json", python]
          .every(marker => isRegularFile(path.join(root, marker)))) {
      throw new Error("Required local project files are unavailable");
    }
    return root;
  } catch {
    throw new Error("Не удалось найти локальный проект Noda. Проверьте файл noda-project.json рядом с файлами приложения.");
  }
}

function findPortableSource(resourcesPath) {
  const root = path.join(resourcesPath, "noda-runtime");
  if (!fs.existsSync(root)) return null;
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()
      || !["backend/app_runtime.py", "scripts/windows-portable/provision.ps1"]
        .every(marker => isRegularFile(path.join(root, marker)))) {
    throw new Error("The Noda package is incomplete. Extract the complete Noda folder again.");
  }
  return root;
}

module.exports = { resolveProjectRoot, findPortableSource };
