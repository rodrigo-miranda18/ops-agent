#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await writeFile('captured-prompt.txt', prompt);
console.log(`<!-- CLASSIFICATION: INCONCLUSIVO -->
<!-- VECTOR: Conexões -->
<!-- TECHNICAL_DIAGNOSIS_START -->Evidence unavailable in test fixture.<!-- TECHNICAL_DIAGNOSIS_END -->
<!-- CS_COMMENT_START -->Investigation pending.<!-- CS_COMMENT_END -->
<!-- ENGINEERING_ACTION_START -->
{"decision":"INSUFFICIENT_EVIDENCE","confidence":"low","summary":"Unknown cause","reason":"Insufficient evidence","repositories":["service-15"]}
<!-- ENGINEERING_ACTION_END -->`);
