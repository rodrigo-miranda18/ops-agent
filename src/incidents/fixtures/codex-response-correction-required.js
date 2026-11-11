#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await writeFile('captured-prompt.txt', prompt);
console.log(`<!-- CLASSIFICATION: INCONCLUSIVO -->
<!-- VECTOR: Conexões -->
<!-- TECHNICAL_DIAGNOSIS_START -->Causa confirmada no fixture de teste.<!-- TECHNICAL_DIAGNOSIS_END -->
<!-- CS_COMMENT_START -->Correção em andamento.<!-- CS_COMMENT_END -->
<!-- ENGINEERING_ACTION_START -->
{"decision":"CORRECTION_REQUIRED","confidence":"high","summary":"Causa confirmada","reason":"Correção necessária","repositories":["service-15"]}
<!-- ENGINEERING_ACTION_END -->`);
