/** Per-test-process environment isolation — runs before each test file via --import. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "companion-test-"));
process.env.NODE_ENV = "test";
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "unittest-password-1";
process.env.LOG_LEVEL = "error";
