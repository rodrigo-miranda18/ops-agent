#!/usr/bin/env node
for await (const chunk of process.stdin) void chunk;
console.log(`<!-- CLASSIFICATION: MAL_ENTENDIDO_COM_OPORTUNIDADE -->
<!-- VECTOR: Conexões -->
<!-- TECHNICAL_DIAGNOSIS_START -->Falha confirmada no serviço externo.<!-- TECHNICAL_DIAGNOSIS_END -->
<!-- CS_COMMENT_START -->Correção em andamento.<!-- CS_COMMENT_END -->
<!-- ENGINEERING_ACTION_START -->
{"decision":"IMPROVEMENT_RECOMMENDED","confidence":"high","summary":"Retry ausente","reason":"O cliente não repete a chamada.","repositories":["invented-service"]}
<!-- ENGINEERING_ACTION_END -->`);
