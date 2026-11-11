# VOID

**One intelligence. Multiple minds.**

VOID is an open-ended personal AI project built around a multi-agent architecture. A central conversational orchestrator coordinates specialized AI agents, tools, memory, and automations to assist with everyday tasks and software development.

## Architecture

- **Main Agent:** Conversation, task planning, delegation, and response synthesis.
- **Agent Runtime:** Execution control, permissions, budgeting, and task lifecycle.
- **Specialized Agents:** Development, research, personal assistance, automation, memory, and system operations.
- **Model Router:** Selects AI models according to capabilities, complexity, and cost.
- **Memory Engine:** Persistent contextual memory.
- **Automation Engine:** Scheduled workflows and external integrations through n8n.

## Tech Stack

- TypeScript / Node.js
- Next.js
- PostgreSQL
- Multi-model AI APIs
- n8n
- Server-Sent Events (SSE)

## Project Status

🚧 Early development — architecture and infrastructure setup.

## Manual specialist plan

Run `npm run demo:plan` for the deterministic local simulation. With Node.js 22.14 or later, `npm run demo:plan:live` reads `OPENROUTER_API_KEY` from the environment or an optional local `.env` file.

The live demo accepts `openrouter/free` or an explicit `:free` model. Set `OPENROUTER_DEV_MODEL` and `OPENROUTER_RESEARCH_MODEL` to select models independently. The demo defaults to 900 output tokens for development and 800 for research. Override these with `OPENROUTER_DEV_MAX_OUTPUT_TOKENS` and `OPENROUTER_RESEARCH_MAX_OUTPUT_TOKENS` within 1–2048. Reasoning can use part of that allowance.

Run `npm run demo:plan:live -- --diagnostics` to see the returned model, HTTP status, finish reason, content size and available token metrics on stderr. In PowerShell, use `npm.cmd` if `npm` consumes the argument separator. Diagnostic events omit credentials, prompts, generated text, reasoning text and raw error bodies.

Only a response with `finish_reason: "stop"` and usable final text completes a step. Even useful partial text at the token limit is treated as incomplete and recorded as `failed` by the executor. Independent completed steps keep their output. If usage is absent or null, usage stays unavailable. Invalid metrics are rejected.

## Governed execution

Create one `ExecutionGovernance` per host process and give it an `AgentRuntime` and a `SQLiteCheckpointStore`. Start with a plan, an `AgentContext` and optional effort and limit overrides. The same `PlanExecutor` schedules each run. Use `onProgress` for events, `partial(id)` for the durable snapshot, `pause(id)` for cooperative pause, `resume(id, context, extension)` for an operator-approved continuation, and `cancel(id)` to stop while retaining history. Supply a fresh context on resume. Keep approval methods on the trusted host side.

`auto` selects `low` by default. The reference times are warnings. An optional `pauseAfterMs` and the authorized step, call and output-token limits stop new work. In-flight calls are allowed to settle during a pause. Cancellation passes an abort signal to active work. The two shared concurrency pools cap active steps and active model calls separately across runs of the coordinator, with a per-run ceiling as well. Use one coordinator per host process for a common cap. SQLite leases protect the same execution ID across processes.

Governed calls admit only OpenRouter's free router, explicit `:free` variants and providers configured as trusted local code. The execution policy keeps the financial ceiling at zero and blocks paid dispatch. Recorded cost remains unknown without billing data. Output-token reservations use the configured per-call limit and release unused capacity on settlement. Missing metrics pause future calls when an output-token budget is active. The legacy `AgentContext.budgetLimit` field keeps its existing meaning. System effort does not configure provider reasoning.

Checkpoints are atomic SQLite transactions with version and checksum validation. They retain plan inputs and results in plaintext. Store the database in a private location, apply file permissions and retention suitable for your data, and keep secrets out of objectives and generated output. The checkpoint format excludes the execution context, its metadata and credentials. Node.js 22.14 supports the built-in `node:sqlite` module with an experimental warning.

After process loss, recovery keeps committed results and marks unconfirmed running steps as interrupted failures. Calls reserved before the crash remain counted and their usage is unknown. Only pending steps with satisfied dependencies are eligible to run. A step deferred before its first model dispatch may run again on approval. Registered agents are trusted code and must avoid side effects outside the model router. The system does not provide exactly-once delivery for external calls. Elapsed time is confirmed through the most recent durable checkpoint.

Run the local demonstration in two Node processes against a fresh database file.

```powershell
npm.cmd run demo:governance -- start .\void-demo.sqlite
npm.cmd run demo:governance -- resume .\void-demo.sqlite
```

The first command uses a deterministic clock to emit a warning and pause after two steps. The second applies an explicit extension and runs only the third step.

## Conversational MainAgent

Run `npm run chat:void` to open the deterministic MOCK terminal. Type a supported demo question or use `/help`. Use `npm run chat:void:live` for a real OpenRouter conversation. Every terminal reply identifies its mode. `npm run demo:main` runs scripted local scenarios for a direct answer, parallel specialists with live progress, approval, resume and partial failure.

- `/pending` lists unfinished executions for the current session. Use `/use ID` to select one and `/partial` to see its saved results.
- `/pause` pauses cooperatively. Use `/resume` to continue a paused plan or `/approve calls=1` to authorize a new call. Approval also accepts `steps`, `timeMs` and `outputTokens`.
- `/cancel` stops the selected execution and preserves available results. `/quit` exits the terminal.
- `/mode` shows the current provider. `/effort high` changes the policy for future messages. `/models` shows the configured routes and models returned for the selected execution.

**Persona do VOID.** O perfil padrão é `void-v1`. Para usar o estilo anterior, defina `VOID_PERSONA=off` no ambiente do terminal ou do servidor e reinicie o processo. Em integrações TypeScript, a opção `persona` do MainAgent tem precedência. A persona orienta a resposta direta e dá um título à seleção validada de resultados dos especialistas. Os trechos continuam sendo reproduzidos na íntegra, conforme selecionados.

**Modo `tools` (experimental).** Com `VOID_CONVERSATION_MODE=tools`, o VOID conversa em texto livre com tool calling nativo em vez do envelope JSON: os especialistas viram tools (`ask_dev`, `ask_research`), o modelo decide quando chamá-las e escreve a resposta final com a própria voz (persona `void-v2`). O caminho antigo continua sendo o padrão e serve de fallback quando o modelo não suporta tools. [Detalhes, limites e o que ficou de fora](docs/tool-calling-mode.md)

The default databases are `void-chat.sqlite` for MOCK and `void-chat-live.sqlite` for LIVE. Set `VOID_CHAT_DB` to a private path and `VOID_CHAT_SESSION` to select a session. The conversation turns use a separate SQLite table from execution checkpoints. Inputs and results are stored in plaintext. Each planning request uses four recent completed turns by default, with a 2,000-character cap per history message. After a restart, recover the execution ID with `/pending`. Prior progress messages are not replayed. Session IDs scope data in the trusted host; they are not an authentication mechanism.

`VOID_EFFORT` accepts `auto`, `low`, `medium`, `high` or `max`. Set `VOID_CHAT_MAX_CALLS` to override the starting call budget. The planning call counts toward delegated work, and synthesis uses the remaining governed budget when available. The final answer always includes the confirmed results and outstanding failures or steps. Model-assisted synthesis accepts only excerpts verified against completed outputs. Direct dependency evidence is limited to 4,000 characters per dependency and 12,000 total and is treated as untrusted input.

`npm run chat:void:live` loads `OPENROUTER_API_KEY` from the environment or `.env`. Use `npm.cmd run chat:void:live` on Windows PowerShell if its npm wrapper causes problems. Keep personal and confidential data out of the free endpoints. See the [model matrix, overrides and live benchmark](docs/model-routing.md). The automated tests and default demo run locally.

The ResearchAgent preset uses Ultra with an explicit supported reasoning setting. `npm.cmd run benchmark:research:live` compares two verified free routes on identical synthetic evidence, with a two-call ceiling. Model selection, zero-cost authorization and execution limits are separate. [Research benchmark and configuration](docs/model-routing.md#phase-32-research-benchmark)

## Vision

Build a personal AI that can understand requests, coordinate specialized capabilities, execute authorized actions, remember relevant context, and deliver unified responses through a single conversational interface.

---

*VOID — One intelligence. Multiple minds.*

## Singularity OS (Fase 4.1)

Na raiz do repositório, com Node.js 22.14 ou superior:

```powershell
npm.cmd install
npm.cmd run dev:web
```

Abra [http://127.0.0.1:3030](http://127.0.0.1:3030). O modo padrão, **MOCK**, usa respostas simuladas e executa o MainAgent e os especialistas do núcleo. Para usar o OpenRouter, configure `OPENROUTER_API_KEY` no ambiente ou no arquivo local `.env` e execute `npm.cmd run dev:web:live`. O indicador **LIVE** identifica o modo selecionado. Perguntas que dependem de modelo exigem uma credencial e rotas gratuitas válidas. Os comandos de interface por texto e voz também passam pelo modelo. Os controles manuais são locais. A autorização e a verificação de gratuidade continuam a cargo do núcleo e do provedor.

- **Focus** mostra apenas o anel. Clique no anel ou pressione **Ctrl+K** (**⌘K** no Mac) para abrir a entrada de texto e voz. Enter envia e Shift+Enter insere uma quebra de linha.
- Diga ou digite **modo workspace** para abrir a interface completa e **voltar ao focus** para retornar ao anel. **Workspace** mostra dependências, etapas, modelos, resultados originais e eventos. No celular, alterne entre Conversa e Operações. O seletor de esforço em **Configurações** vale para o próximo envio e as rotas de uma execução existente vêm do checkpoint.
- Diga ou digite **abra configurações**, **abra uso**, **abra sessões** ou **mostre operações** para abrir uma janela. Em MOCK, experimente **Crie uma interface com um contador de expedições e um checklist de equipamentos** para abrir uma prévia React interativa no Focus. [Comandos, componentes e controles da janela](docs/ui-runtime.md)
- O exemplo **Resposta direta** distingue concorrência de paralelismo. **Trabalho em equipe** aciona DevAgent e ResearchAgent. Envie `Analise esta função com falha simulada.` em MOCK para ver uma falha parcial com preservação do resultado de DevAgent.
- Para reproduzir aprovação em MOCK, defina `$env:VOID_WEB_MAX_CALLS = "2"` no PowerShell antes de iniciar o servidor. Envie **Trabalho em equipe**, aguarde a pausa, recarregue a página, diga ou digite **mostre operações** e use **Autorizar e retomar**. A primeira chamada é de planejamento. A segunda conclui DevAgent. A extensão sugerida cobre ResearchAgent e síntese. Encerre o servidor e use `Remove-Item Env:VOID_WEB_MAX_CALLS` para voltar aos limites por esforço.
- O histórico e os checkpoints ficam em `web/.data/void-mock.sqlite` e `web/.data/void-live.sqlite`. `VOID_WEB_DB` permite escolher outro arquivo e `VOID_WEB_PORT` altera a porta. Use um processo web por arquivo de banco. Os dados persistidos são texto em claro.

### Voz de saída

A voz vem habilitada para novas respostas finais. Quando a síntese externa está configurada, o Singularity OS prefere **ElevenLabs (pode consumir créditos)**. Em caso de cota, indisponibilidade ou falha de síntese, usa uma voz local pt-BR, se houver uma disponível. Em **Configurações → Voz de saída**, o navegador guarda a ativação, o provedor, a voz do sistema, o volume e a velocidade. **Parar** interrompe o áudio atual. A reprodução depende de interação com a página. Se o navegador bloquear o áudio, clique em **Reproduzir resposta**.

### Microfone e palavra de ativação

- **Clique para falar** abre o microfone para uma mensagem e o libera ao terminar. **Permitir microfone** inicia a configuração da escuta mãos livres na aba visível. Clique e confirme o acesso se o navegador pedir. Comece a frase com **VOID**. Você pode dizer o comando na mesma frase ou em seguida. A palavra de ativação sozinha não gera uma mensagem.
- Em **Configurações → Microfone**, o modo mãos livres vem ligado por padrão e a escolha fica salva no navegador. Nessa seção, ajuste a pausa que encerra a fala (0,5 a 4 s, padrão 1 s) e o tempo de inatividade (1 a 30 min, padrão 5 min). Após a inatividade, o modo mãos livres volta a aguardar **VOID**. Para desligar a escuta automática, desmarque **Modo mãos livres**. Abrir Configurações, ocultar ou recarregar a aba e trocar de conversa liberam o microfone. Se a permissão continuar concedida, o VOID pode retomar a escuta ao voltar à aba.
- O microfone é liberado enquanto o agente processa e durante a preparação e reprodução do áudio. O modo mãos livres retoma após uma breve espera se o navegador ainda informar que o acesso está concedido. Caso contrário, clique para iniciar a escuta novamente. Aguarde o estado **Escutando** para falar novamente.
- Por padrão, o reconhecimento usa o pacote local **pt-BR** da Web Speech API, em localhost ou outro contexto seguro. Em **Configurações → Microfone**, use **Instalar reconhecimento pt-BR** quando o navegador oferecer o pacote. A disponibilidade depende do navegador, sistema e políticas locais. [Chrome passou a oferecer a API local na versão 139](https://developer.chrome.com/release-notes/139?hl=pt_br). O fallback para o serviço de reconhecimento do navegador é opcional nas configurações e pode enviar áudio ao serviço.
- A ativação procura a palavra no começo do texto reconhecido. A precisão depende de como o motor pt-BR transcreve “VOID” e pode variar com sotaque ou ruído. O detector de pausa mede energia no microfone com Web Audio. Ruído contínuo pode atrasar o fechamento, e fala muito baixa pode passar despercebida. Cada trecho é limitado a 45 segundos.
- O servidor local recebe a transcrição pela rota normal de mensagens. O MainAgent executa comandos inequívocos de interface localmente. No modo LIVE, os pedidos que precisam de um modelo usam o OpenRouter com os limites existentes. Silêncio, texto vazio e eventos repetidos são filtrados antes do envio. O MainAgent pode decidir ignorar uma fala enviada, sem resposta falada nem uso da fala no contexto posterior. Essa decisão ainda pode consumir uma chamada em LIVE.

Para habilitar ElevenLabs, entre no painel do provedor e crie uma chave restrita a **Text to Speech**, com limite de créditos. Escolha o ID de uma voz em português do Brasil. Acrescente estas variáveis ao `.env` na raiz do VOID, preenchendo a chave e o ID somente nesse arquivo local.

```dotenv
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
VOID_ELEVENLABS_TTS=0
```

Reinicie o servidor para carregar a configuração. O modelo aceita também `eleven_multilingual_v2` e `eleven_turbo_v2_5`. O idioma é português e o sotaque depende da voz escolhida. Ao usar ElevenLabs, o backend envia o texto da resposta final ao provedor, inclusive se o chat estiver no modo MOCK. Defina `VOID_ELEVENLABS_TTS=1` somente se autorizar a síntese externa, que pode consumir créditos. O painel **Uso** consulta a assinatura separadamente. Um `401 missing_permissions` nessa consulta indica falta de acesso à leitura da assinatura. A permissão de síntese é **Text to Speech**.

O servidor limita a síntese a uma chamada simultânea, seis por minuto, 2.000 caracteres por resposta e 6.000 por dia UTC. As reservas persistem no SQLite, incluindo as tentativas que falham após a reserva. Um 429 indica limitação de requisições. O código `quota_exceeded` indica cota reportada como esgotada. O servidor respeita `Retry-After` quando disponível e usa uma pausa local de cinco minutos nos demais casos. Respostas acima do limite seguem inteiras para a voz local. A interface pode exigir reprodução manual se o navegador bloquear o áudio automático.

### Uso e limites

Abra **Uso** na barra superior. O painel mostra o consumo registrado nesta instalação em sete dias, separado por provedor e pelo modelo retornado ou solicitado. O OpenRouter fornece tokens e custo quando presentes em `usage`. A ElevenLabs fornece o custo de geração no cabeçalho `character-cost` quando disponível. Caracteres enviados são uma estimativa local. O histórico agregado antigo aparece separado porque o contador anterior guardava apenas tentativas, falhas e tokens agregados.

O painel carrega os dados do SQLite antes de consultar as cotas externas. Se um provedor falhar, o painel mantém as métricas locais e informa o erro daquela consulta. Para atualizar as cotas, o servidor consulta `GET /api/v1/key` no OpenRouter e `GET /v1/user/subscription` na ElevenLabs com as chaves locais. Essas consultas são somente leitura e o servidor reutiliza o resultado por um minuto. Se a chave da ElevenLabs tiver apenas escopo de síntese, a assinatura pode aparecer como desconhecida. Para exibi-la, a chave precisa também de permissão de leitura de usuário/assinatura. O gasto reportado pelo OpenRouter se refere à chave e o excedente da ElevenLabs se refere à assinatura. A cota diária de rotas gratuitas da conta vem de `free_model_daily_requests` quando disponível. Os eventos por modelo registram a rota solicitada, o modelo retornado e os sinais de limite disponíveis. Um 429 genérico aparece com origem desconhecida.

No modo LIVE, as rotas do OpenRouter continuam restritas a modelos gratuitos verificados e ao teto de preço zero. Um 429 pausa a rota conforme `Retry-After` ou por um minuto na falta do cabeçalho. As rotas de reserva verificadas continuam disponíveis para as falhas elegíveis, como indisponibilidade, quando a política de execução permite. Os bloqueios locais de TTS aparecem em uma seção separada da cota da assinatura.

### Servidor e API local

`web/server.mjs` mantém um único processo Node e serve a interface Next.js e a API HTTP na mesma origem. O navegador compartilha os contratos da interface e as funções que preparam o texto de voz. MainAgent, governança, ModelRouter, credenciais e SQLite ficam no servidor.

| Método | Rota | Função |
| --- | --- | --- |
| GET | `/api/system?effort=auto` | Modo, disponibilidade, esforço resolvido e modelos configurados |
| GET | `/api/provider-usage` | Lê métricas e limites locais sem consultar os provedores |
| POST | `/api/provider-usage` | Recebe `{}` e acrescenta cotas obtidas por consultas de leitura aos provedores |
| GET / POST | `/api/sessions` | Listagem e criação de sessões |
| GET | `/api/sessions/:session` | Histórico, estado atual e resultados |
| POST | `/api/sessions/:session/messages` | Recebe ID da mensagem, texto e esforço. Retorna 202 |
| POST | `/api/sessions/:session/messages/:id/voice` | Recebe `{}` e gera áudio para uma resposta final da sessão, com proteção de origem local |
| GET | `/api/sessions/:session/events` | Fluxo SSE de snapshots com IDs de evento |
| GET | `/api/sessions/:session/executions/:id` | Estado e resultados de uma execução |
| POST | `/api/sessions/:session/executions/:id/action` | Pausa, cancelamento, aprovação de extensão e retomada |

A execução continua se a conexão SSE cair. Ao reconectar, o navegador substitui o estado local pelo snapshot atual, identificado por sessão. A API deduplica envios pelo ID da mensagem, rejeita ações de outra sessão e verifica a revisão do checkpoint antes de aceitar uma ação. As últimas 80 notificações por sessão são mantidas em memória enquanto o servidor estiver ativo. Depois de reiniciar o processo, a conversa e as etapas são reconstruídas do SQLite. A linha do tempo de um processo anterior pode perder notificações intermediárias, como o instante exato de uma retomada. A recuperação de chamadas em voo segue a política de interrupção do núcleo.

O servidor escuta em loopback e valida Host, Origin e payloads. Esta interface é para um único usuário local. Exposição pública exige autenticação, autorização multiusuário e revisão de implantação. Mantenha o banco e as credenciais em local privado.

### Verificações

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd run build
npm.cmd run build:web
npm.cmd run test:web:browser
npm.cmd run start:web
```

Os testes da API usam um transporte em memória e provedores simulados. Os testes do navegador iniciam o build em um servidor local temporário e usam Edge no Windows por padrão. Defina `VOID_BROWSER_EXECUTABLE` para outro Chromium ou `VOID_WEB_SCREENSHOTS` para uma pasta de capturas. A variante de produção LIVE é `npm.cmd run start:web:live`. Os comandos web requerem o processo Node persistente, inclusive em produção local.

### Diagnóstico de geração LIVE

Defina `$env:VOID_GENERATION_DIAGNOSTICS = "1"` antes de iniciar a interface ou o terminal. O console do servidor registra JSON com sessão, identificador de geração/execução, esforço, papel, modelos, parâmetros de saída, raciocínio, término, latência, uso reportado e categoria da falha. A decisão validada é registrada separadamente, com resultado direto, delegação ou rejeição. O uso ausente continua ausente. Os registros omitem chave, cabeçalhos e conteúdo de mensagens.

Para comparar uma solicitação multilinha nos dois canais, salve o texto completo como UTF-8 em `prompt.txt`, inicie uma sessão nova no navegador e selecione o mesmo esforço:

```powershell
$env:VOID_EFFORT = "medium"
$env:VOID_CHAT_MAX_CALLS = "4"
$env:VOID_WEB_MAX_CALLS = "4"
npm.cmd run chat:void:live -- --prompt-file prompt.txt
```

Envie o mesmo conteúdo no navegador após iniciar `npm.cmd run dev:web:live` com as mesmas variáveis. Use a mesma configuração `VOID_*_MODEL`, raciocínio e limites de saída. O terminal interativo lê uma linha por mensagem. O modo `--prompt-file` usa SQLite em memória e envia o arquivo como uma única solicitação. Os testes automatizados comparam o corpo completo da requisição nos dois canais usando um provedor simulado, inclusive a opção JSON e as restrições de custo.

A decisão e a síntese pedem JSON nativo quando o catálogo confirma `response_format`. Nos demais modelos, o contrato é solicitado pelo prompt e validado localmente. O JSON da decisão e o DAG continuam sujeitos aos mesmos validadores. Uma geração interrompida nunca vira resposta validada. Em caso de falha na síntese, a conversa avisa e apresenta os resultados confirmados dos especialistas.


Em Auto/Low, o teto da decisão do Lightning é 3.600 tokens e o raciocínio opcional é desativado se o catálogo confirmar suporte. Para usar o padrão do provedor, defina `VOID_MAIN_REASONING_EFFORT_LOW=default`. Em um ensaio de análise de código, os 2.600 tokens anteriores foram consumidos integralmente por raciocínio e o OpenRouter devolveu `finish_reason: length` sem texto. Aumentar o teto para 4.600 ainda permitiu uma truncagem com 4.538 tokens de raciocínio. Limites mais baixos definidos pela governança ou pela configuração do host continuam valendo. Se o detalhamento opcional de raciocínio contradiz os totais, o uso fica desconhecido para a governança. Uma resposta com texto final ainda passa pela validação de decisão e plano. Totais primários inválidos continuam sendo rejeitados. Em Medium, o teto passou de 1.900 para 2.250 tokens para DevAgent e de 1.200 para 1.500 para ResearchAgent após as duas rotas atingirem o limite em um ensaio de delegação.
