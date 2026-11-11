# Auditoria de integração — 10/11/2026

Base: `main`, commit `f47de9f728f4e9fd466df151da0ddb8496dac818` (`commit pra comecarmos a trabalhar mobile`). Checkout inicialmente limpo; `git fsck` sem erros. AgentRenderer, AgentRuntime, AgentRegistry, DevAgent, MainAgent, UI Runtime, Window Manager e `.agents/skills/criar-agente/SKILL.md` presentes. A referência remota foi conferida novamente antes da entrega e permanecia na mesma base.

## Resultado e causas confirmadas

| Achado | Evidência e correção |
| --- | --- |
| O modelo podia produzir uma chamada válida para “Abra a configuração”, mas o MainAgent a rejeitava. | `requestedWindows`/`requestsRender`/`requestsDisplay` restringiam a oferta e a validação por vocabulário. A regressão nova falha na base, com `undefined` em vez de `open_panel`. A oferta agora deriva das operações registradas e autorizadas, independentemente da frase. |
| A troca de modo existia apenas como comando lexical local. | `ui.switchMode` e `ui.resetLayout` conectam as ações já existentes ao caminho semântico, pelo mesmo AgentRenderer/UI Runtime. Não foram criados modos nem um segundo executor. “Interface principal” é descrita como Workspace; Focus é o anel. |
| Descoberta e execução de ferramentas eram acopladas manualmente no MainAgent. | Metadados, `accepts` e `prepare` acompanham o token `AgentOperation`. `toolCatalog` anuncia e `invokeTool` resolve a mesma operação, com nomes únicos, autorização, orçamento, cancelamento e rastreamento. Um teste adiciona um agente não visual e o executa pelo MainAgent sem acrescentar ramificações ao coordenador. |
| Uma transcrição final válida era ignorada quando o detector de volume não havia marcado início de fala. | O teste de voz novo falha na base: a fase permanece `wake`. Agora a transcrição final também conta como evidência de fala; VAD continua delimitando silêncio. O teste confirma ativação, envio único, deduplicação e ausência de fallback externo sem consentimento. |
| O contrato visual incentivava a menor árvore possível, e o contador MOCK era quase sem composição. | O DevAgent passou a orientar hierarquia, instrução curta, agrupamento e rótulos acessíveis usando as classes e widgets existentes. O contador tem controles de toque, número destacado e anúncio acessível. Sem aumento de teto de tokens nem relaxamento do isolamento. Qualidade estética com modelo LIVE não foi medida. |
| Falhas de subtarefas visuais guardavam estado, mas não sua categoria. | Migração aditiva de `ui_agent_tasks.failure_category`; erros de orçamento/delegação são consultáveis sem guardar mensagens cruas do provedor. |

**Não confirmado como defeito da base:** a pergunta exata “Quais agentes estão disponíveis?” já incluía AgentRenderer na web. O catálogo autorizado também já aparecia no prompt. O terminal registra somente DevAgent e ResearchAgent, pois não tem UI Runtime; essa diferença de canal foi preservada. A resposta negativa relatada não foi reproduzida com um LLM real. Os filtros lexicais e a ausência de ferramentas de layout explicam parte da inconsistência, mas não provam a origem de toda resposta anterior.

## Fluxo preservado

MainAgent interpreta a intenção → AgentRegistry resolve a ferramenta → AgentRuntime executa AgentRenderer → ComponentRegistry procura uma versão → AgentRenderer delega diretamente ao DevAgent quando necessário → compilador valida TSX e faz renderização de teste → ação validada chega ao UI Runtime → Window Manager apresenta a prévia.

- Chamadores e capacidades continuam obrigatórios. O modelo não escolhe permissões, sessão, callback de geração ou orçamento.
- Painéis nativos, schemas e componentes passam pelo AgentRenderer no caminho do modelo. Atalhos locais explícitos continuam funcionando sem modelo.
- A interpretação de intenção é responsabilidade do modelo; validação estrutural não garante que o modelo tenha entendido uma negação. Testes com respostas simuladas não medem essa competência.
- Catálogo de componentes continua restrito à sessão. Reabrir por chave reutiliza a versão sem gerar novamente. Revisar preserva versões.
- Mantidos limite de TSX, tags/classes permitidas, Counter/Toggle, proibição de código arbitrário/importações/eventos, compilação com esbuild, iframe de origem opaca e CSP sem rede.
- A tentativa compacta após truncamento preserva agora catálogo, regras e histórico, usa o mesmo validador e desconta chamadas/tokens. O limite de uma tentativa adicional por estágio foi mantido.
- Sem dependências novas, troca de modelos, merge ou deploy.

## Arquivos e subsistemas

- `src/runtime/AgentOperation.ts`, `AgentRegistry.ts`, `AgentRuntime.ts`: contrato, descoberta e despacho de ferramentas; categoria de falha.
- `src/agents/MainAgent.ts`, `src/conversation/mainDecision.ts`: decisão sem filtro lexical, despacho pelo registro e validação de resultado.
- `src/web/ui-runtime.ts`, `ui-contracts.ts`, `render-operations.ts`, `runtime.ts`: descrição/validação de ferramentas e integração de layout com o renderer existente.
- `src/agents/DevAgent.ts`, `src/web/component-preview.ts`: composição visual e usabilidade do contador.
- `src/web/ComponentRegistry.ts`: migração aditiva do diagnóstico de subtarefas.
- `web/app/voice-input.ts`: transcrição final independente do limiar VAD.
- `tests/IntegrationAudit.test.ts`, `tests/voice-input.test.ts`, `tests/ComponentRendering.test.ts`, `tests/WebApi.test.ts`: regressões e contratos de integração.
- `docs/ui-runtime.md` e `.agents/skills/criar-agente/SKILL.md`: integração pelo registro e distinção entre simulação e LIVE.

## Validação executada

| Verificação | Resultado |
| --- | --- |
| Suíte original, antes das alterações | 203/203 passaram. Isso não detectava as regressões abaixo. |
| Dois testes novos em checkout separado da base | 2 falhas esperadas: singular “configuração” rejeitado e wake word com voz abaixo do limiar descartada. |
| Suíte final `npm test` | **213/213 passaram**, zero skips. |
| `npm run lint` | Passou, 96 arquivos. |
| `npm run typecheck` e `npm run typecheck:web` | Passaram. |
| `npm run build` e `npm run build:web` | Passaram. |
| Navegador real no contêiner | Bloqueado antes dos testes: Chromium não inicia, `socket() failed: Operation not permitted`. Os 18 casos da suíte não foram validados. |
| Navegador remoto alternativo | Servidor local inacessível: `ERR_CONNECTION_REFUSED`, inclusive após confirmar inicialização. |
| OpenRouter LIVE | Não executado. Testes que mencionam LIVE interceptam o provedor com fixtures; nenhuma inferência real, paga ou gratuita, foi usada. |
| Microfone físico | Não executado. Reconhecimento, áudio e permissões simulados. |

Os testes finais exercitam paráfrases com decisões simuladas, catálogo autorizado, ferramenta nova sem edição do MainAgent, chamadas diretas, delegação pai–filho, reutilização/revisão, isolamento entre sessões, TSX inválido, reparo, truncamento, orçamento, permissão negada, falha do autor e cancelamento. Há testes HTTP/SSE reais contra o servidor local, compilação real com esbuild e renderização React no servidor; isso **não equivale** à interação no navegador.

## Pendências e limites

1. **Window Manager:** auditado por código, mas os controles não puderam ser operados no navegador. Não foi identificada uma causa confirmada para o relato e não houve correção especulativa nesse arquivo. Abrir/fechar, arrastar, redimensionar, maximizar/restaurar, minimizar, foco, responsividade e sobreposição ao anel precisam da suíte abaixo e de teste manual. O produto mantém uma janela ativa; abrir outro painel substitui o anterior. Não foi introduzido gerenciamento de múltiplas janelas.
2. **Semântica LIVE:** a infraestrutura aceita as operações sem depender de palavras específicas, mas a escolha correta pelo modelo real precisa ser avaliada. MOCK continua sendo um conjunto explícito de cenários, não um interpretador semântico.
3. **Visual LIVE:** Counter/Toggle continuam sendo as únicas interações do subconjunto TSX. Não se promete uma interface arbitrária. Revisão estética e funcionamento da prévia no navegador permanecem pendentes.
4. **Voz:** validar pacote pt-BR, concessão/revogação de microfone, wake word em volume baixo, silêncio, fim da sessão, retorno da aba e erro de rede no notebook. Fallback do navegador pode usar um serviço remoto e permanece opt-in. Nenhum áudio foi enviado nesta auditoria.
5. **Observabilidade:** subtarefas e falhas ficam no SQLite; não foi acrescentado um painel de subtarefas. Estado dos widgets continua local à prévia e não é persistido.

**O critério final de sucesso ponta a ponta ainda não está atestado**, especialmente navegador e modelo LIVE.

## Entrega

A branch `fix/void-integration-audit` e o commit existem no checkout remoto de trabalho, mas **não foram publicados no GitHub**. O push Git falhou por ausência de credencial; a API autenticada retornou `403 Resource not accessible by integration`. `main` permanece intacta. O patch entregue contém o commit completo, incluindo este relatório e os testes.

## Reproduzir no notebook

```sh
git fetch origin
git switch -c fix/void-integration-audit f47de9f728f4e9fd466df151da0ddb8496dac818
git am /caminho/para/void-integration-audit.patch
npm ci
npm run lint
npm run typecheck
npm run typecheck:web
npm test
npm run build
npm run build:web
npm run test:web:browser
```

Substitua o caminho pelo local onde baixou o patch. Se a branch já existir localmente, escolha outro nome. Preserve alterações locais antes de trocar de branch. A suíte procura Edge no caminho padrão do Windows; para outro executável, configure `VOID_BROWSER_EXECUTABLE` com o caminho completo. Os testes de navegador removem as chaves de seus processos filhos e usam MOCK, inclusive o cenário “LIVE sem modelo”.

Para teste manual sem modelo:

```sh
npm run dev:web
```

Abra o endereço mostrado pelo servidor. Execute `Abra configurações`, arraste pelo título, redimensione pelo canto, maximize/restaure, minimize/restaure e feche. Execute `Modo workspace`, depois `voltar ao focus`. Em Focus, crie `uma interface com um contador de expedições e um checklist de equipamentos`; clique em +/−, marque o checklist, minimize/restaure e reabra a mesma janela. Teste largura de 320 px e confira se os controles seguem acessíveis.

Para testar a interpretação real **somente com sua chave local e rotas gratuitas já autorizadas**, use `npm run dev:web:live`. Não compartilhe a chave. Envie:

- `Quais agentes estão disponíveis?` e `O que o AgentRenderer consegue fazer?`
- `Abra configurações.`, `Abra a configuração.`, `Quero acessar meus ajustes.`
- `Modo workspace.` e `Quero voltar à interface principal.` (Workspace)
- `Crie uma janela com contador interativo.` e uma reabertura do componente salvo.
- `Não abra configurações.` e `Como funcionam os ajustes?` — devem responder sem abrir janela.

Na voz, habilite apenas escuta local para o primeiro teste, diga “VOID, abra configurações” em volume normal e baixo e confira envio único. Teste o fallback externo somente se desejar autorizá-lo nas configurações.

Evidência de delegação pode ser consultada no banco configurado em `VOID_WEB_DB`:

```sql
SELECT caller, agent_id, capability, status, parent_task_id, failure_category
FROM ui_agent_tasks ORDER BY started_at;
```

Uma criação nova deve registrar `main-agent → agent-renderer → dev-agent`. Reabrir uma versão existente não deve gerar uma nova tarefa do DevAgent.
