# Auditoria v2: memória, interface e modelo

Escrita em 12/11/2026 sobre a branch `feat/v2-integration` (merge de `feat/memory` com `feat/tool-calling-mode`, commit `08c1ac6`), antes de qualquer mudança de comportamento. As referências são `arquivo:linha` desse commit.

Fontes: leitura do código, a suíte de testes, e metadados do banco real do servidor web (`web/.data/void-live.sqlite`): contagens, tipos, marcas de resumo e o log de chamadas ao provedor. Nenhum texto de registro de memória ou de conversa foi lido para esta auditoria.

## Resumo dos achados

| # | Achado | Gravidade | Evidência |
| --- | --- | --- | --- |
| 1 | O resumo da sessão anterior foi tentado em toda sessão nova e falhou sempre. Não foi pulado por orçamento. | Alta | Log de chamadas, seção "Pergunta (a)" |
| 2 | Abrir o workspace depende só de o modelo emitir uma tool call válida. No Focus não existe controle manual. | Alta | Banco real, seção "Workspace" |
| 3 | A gravação de memória depende de o modelo chamar `remember`. Não existe via que independa dele. | Alta | `MainAgent.ts:375`, `voidTools.ts:211` |
| 4 | O aviso "Memória: salvei…" nunca aparece no chat web. | Média | `console.tsx:662` |
| 5 | Nada confere se o texto "Anotei." corresponde a uma gravação real. | Média | `MainAgent.ts:456` |
| 6 | Falhas de memória são silenciosas no servidor web. | Média | `runtime.ts:90` |
| 7 | Nesta máquina o SQLite não tem FTS5: a memória roda sempre na busca de fallback. | Informativo | Node 22.14.0, SQLite 3.47.2 |
| 8 | A suíte falhava 46 de 328 testes no Windows por limpeza de arquivos e por forçar FTS5. | Corrigido em `d21aaa8` | Seção "Testes" |
| 9 | O modo JSON (e o fallback `tools_unsupported`) lê a memória, mas nunca grava. | Média | `MainAgent.ts:202`, `persona.ts:152` |

## Ciclo de um turno

1. **Entrada.** A web chama `POST /api/sessions/:id/messages` (`src/web/api.ts:374`). O servidor grava o turno sem resposta (`beginTurn`, `api.ts:389`) e dispara `main.run` com `stream: runtime.live` e `source: "voice"` quando a mensagem veio do microfone (`api.ts:391`).
2. **Sessão.** `MainAgent.run` (`src/agents/MainAgent.ts:162`) entra em `inSession` (`:791`), que recusa uma segunda mensagem na mesma sessão e converte qualquer exceção em uma mensagem `error`.
3. **Esforço e rotas.** `governance.effortLimits` (`ExecutionGovernance.ts:66`) resolve o esforço; `auto` vira `low`, que dá 5 chamadas por turno (`src/governance/effort.ts:17`). As rotas vêm de `liveModelRoutes` (`src/models/modelSelection.ts:92`).
4. **Modo tools.** `converse` (`MainAgent.ts:356`) monta o orçamento (`callBudget`, `voidTools.ts:29`), o histórico (10 turnos, 6.000 caracteres cada), as tools de memória, tenta o resumo da sessão anterior no primeiro turno da sessão (`:379`), monta o bloco de memória (`:381`) e roda `runToolLoop` (`src/conversation/toolLoop.ts:65`) com no máximo `min(6, limits.calls)` iterações. A última iteração sempre desliga as tools (`toolLoop.ts:96`).
5. **Fallback.** Se o provedor responder `tools_unsupported`, o turno cai no coordenador JSON com um aviso no console, uma vez por modelo (`MainAgent.ts:184`).
6. **Modo decision (JSON).** O mesmo `run` monta o prompt `VOID_DECISION` (`:236`), valida a decisão (`parseDecision`) e segue um de quatro caminhos: `ignore`, `direct`, `tool`/`display`, ou `delegate` com plano governado (`governance.start`, `:347`).
7. **Fim do turno em tools.** Grava o histórico (`recordDirect`, `:454`), aplica as escritas de memória (`memoryTurn.commit()`, `:459`), emite as ações de interface, o aviso de memória e a resposta final (`:464`–`:466`).
8. **Saída.** O `sink` da API (`api.ts:221`) publica ações de interface em `UiRuntimeService` (`src/web/ui-runtime.ts:57`), guarda avisos em `notices` e manda um snapshot por SSE (`notify`, `api.ts:179`).

### Orçamento de chamadas

`callBudget(limits.calls)` é um contador por turno, compartilhado pela conversa, pelos especialistas e pela autoria de interface (`MainAgent.ts:362`, `:392`, `voidTools.ts:88`). O resumo só roda se sobrarem duas chamadas depois dele (`budget.take(2)`, `MainAgent.ts:496`). As tools de memória não gastam chamada de modelo.

### Governança

Toda chamada de conversa passa por `planRequest` (`ExecutionGovernance.ts:79`): confere se o modelo é gratuito ou local confiável, o limite de saída e a concorrência. Especialistas chamados como tool no modo tools rodam por `AgentRuntime.execute`, sem checkpoint, pausa ou aprovação. Pause, resume e cancel (`ExecutionGovernance.ts:152`–`:176`, `MainAgent.ts:528`–`:568`) só existem para planos delegados do modo JSON.

## Memória

### O que existe

- **Armazenamento.** `SQLiteMemoryStore` (`src/conversation/MemoryStore.ts:136`), no mesmo arquivo SQLite da conversa. Tabelas `memory_records` e `memory_summary_marks`, as duas `STRICT` (`:145`–`:160`).
- **Tipos reais.** `profile`, `fact` e `summary` (`MemoryStore.ts:6`). Não existem os tipos preferência, projeto ou pessoa: preferências e pessoas entram como `fact`.
- **Campos de um registro.** `id`, `kind`, `text`, `normalized`, `created_at`, `updated_at`, `source_turn_id`, `session_id`. Não há campo de origem nem chave de tema.
- **Deduplicação.** Só por texto normalizado idêntico (`normalizeMemoryText`, `:84`, coluna `UNIQUE`). "Mora em Recife" e "Mora em Olinda" são dois registros; quem evita a contradição é o modelo, se seguir o aviso de `remember` (`voidTools.ts:248`).
- **Limites.** 300 caracteres por fato, 1.200 por resumo, 500 registros, 3 resumos em rodízio (`MemoryStore.ts:37`). Um armazenamento cheio recusa a escrita e nunca apaga sozinho (`:302`).
- **Busca.** FTS5 com `bm25` quando o SQLite tem FTS5; senão, contagem de radicais em comum (`:239`–`:264`). Radical é os cinco primeiros caracteres (`searchStem`, `:108`). O índice FTS é refeito a cada abertura (`:171`).
- **Migrações.** Não há versão de esquema. As tabelas nascem com `CREATE TABLE IF NOT EXISTS`. `ConversationStore` migra por `PRAGMA table_info` e `ALTER TABLE` (`ConversationStore.ts:38`); a memória ainda não precisou.
- **Segredos.** `detectSecret` (`src/conversation/secrets.ts:68`) barra chaves, tokens, senhas, cartões, CPF e CNPJ antes de qualquer escrita (`cleanText`, `MemoryStore.ts:125`).
- **Tools.** `remember`, `recall`, `forget`, `update_memory` (`voidTools.ts:187`). No máximo 3 escritas por resposta.
- **Âncora contra injeção.** `groundedInUserText` (`voidTools.ts:174`): pelo menos metade das palavras do texto precisa aparecer no que o usuário disse nesta conversa, comparando os quatro primeiros caracteres.
- **Bloco no prompt.** `memoryBlockFor` (`src/conversation/persona.ts:143`) e `memoryBlock` (`:106`): perfil (até 800 caracteres), fatos (relevantes primeiro, depois os mais recentes) e o último resumo, no máximo 1.500 caracteres. Fica no fim do prompt de sistema, entre `<memoria_do_usuario>` e a tag de fechamento, com o texto guardado neutralizado contra tags (`inert`, `:85`). O enquadramento diz que são dados e não instruções (`memoryFraming`, `:98`).
- **Escopo.** Todo registro vale em toda sessão. `session_id` é só informativo.
- **Controle do usuário.** `GET /api/memory`, `DELETE /api/memory/:id`, `DELETE /api/memory` com confirmação (`api.ts:320`–`:341`); no terminal, `/memory` e `/forget` (`src/conversation/memoryCommands.ts`).

### Pergunta (b): quando as escritas são confirmadas, e com que garantias

- As tools **encenam** a escrita. `remember` devolve "Anotado. Fica salvo quando esta resposta terminar." (`voidTools.ts:268`) sem tocar no banco.
- A escrita real acontece em `memoryTurn.commit()` (`voidTools.ts:364`), chamado em `MainAgent.ts:459`, **depois** que o loop devolveu um texto final e **depois** de gravar o histórico.
- **Não há commit** quando o turno falha (orçamento, loop esgotado, resposta vazia, cancelamento, erro do provedor) nem quando um turno de voz responde `<ignore/>` (`MainAgent.ts:451`).
- O commit não é uma transação única: cada item tem a sua, e os recusados nessa hora viram `failed` (`voidTools.ts:380`).
- O aviso ao usuário (`describeMemoryCommit`, `voidTools.ts:150`) só sai quando algo mudou.
- **Lacunas.** O modo JSON não tem tools de memória, então nunca grava. Nada compara a resposta do modelo com o que foi gravado: se ele escrever "Anotei." sem chamar `remember`, a conversa segue como se tivesse gravado.

### Pergunta (a): por que o resumo da sessão anterior não foi gerado

**Ele foi tentado em cada sessão nova e falhou todas as vezes. Não foi pulado por orçamento.**

Evidência, da tabela `provider_attempts` do banco real, em 12/11 (UTC):

| Horário | Entrada | Saída | Resultado | Chamada seguinte |
| --- | --- | --- | --- | --- |
| 03:03:07 | 759 tokens | 400 | falhou (HTTP 200) | 03:03:08, conversa, ok |
| 03:07:11 | 281 tokens | 400 | falhou (HTTP 200) | 03:07:12, conversa, ok |
| 03:40:28 | 279 tokens | 400 | falhou (HTTP 200) | 03:40:30, conversa, ok |
| 03:42:16 | 303 tokens | 400 | falhou (HTTP 200) | 03:42:17, conversa, ok |

São quatro sessões novas e quatro tentativas. A entrada pequena é o transcrito mais o prompt `VOID_SUMMARY`; as chamadas de conversa do mesmo período têm cerca de 3.400 tokens de entrada e de 5 a 69 de saída. A saída de exatamente 400 tokens é o teto `summaryTokens` (`MainAgent.ts:101`). `memory_summary_marks` está vazia, e tanto o sucesso quanto a recusa do armazenamento gravariam uma marca (`:516`).

Causa: a chamada de resumo (`MainAgent.ts:504`–`:508`) envia modelo, limite de saída, temperatura e mensagens, mas **não repassa `route.reasoning`**. A rota de síntese do `nvidia/nemotron-3.5-super-vl:free` desliga o raciocínio (`modelSelection.ts:60`–`:63`), e as chamadas de conversa repassam essa configuração (`MainAgent.ts:438`). Sem ela o modelo raciocina, o raciocínio conta no limite de saída, os 400 tokens acabam antes do texto e o provedor devolve `finish_reason=length`, que `OpenRouterProvider.ts:189` transforma em falha `incomplete`.

Consequências:

- A falha cai no `catch` de `MainAgent.ts:518`, que chama `issue("memory")`. O servidor web não registra `onCommunicationIssue` (`src/web/runtime.ts:90`), então ninguém vê.
- Como a marca não é gravada, a tentativa se repete em toda sessão nova e gasta uma requisição da cota gratuita cada vez.
- O tempo limite de 20 s (`summaryTimeoutMs`, `:100`) é outro risco para rotas gratuitas lentas, mas não foi o que aconteceu aqui: as quatro tentativas terminaram em cerca de um segundo.

O comentário de `tests/MemoryRegression.test.ts:42` atribui a falha real a um 429. O log mostra só dois 429 em todo o histórico, nenhum nesses horários. O teste continua válido (o fato não pode depender do resumo), mas a causa registrada ali está errada.

### O que está quebrado ou falta na memória

1. **Captura depende do modelo.** A única via de escrita é a tool `remember`. No banco real há 1 registro, criado às 03:06:04, depois de dezenas de turnos. Com o modelo atual, menções de passagem não viram registro.
2. **"Anotei." sem gravação.** Nenhuma checagem no código.
3. **Resumo.** Quebrado, causa acima.
4. **Aviso invisível na web.** A API guarda o aviso `memory` com `chatText` (`api.ts:237`), mas `console.tsx:662` só desenha avisos enquanto `turn.response === null`. No modo tools o histórico é gravado antes do aviso (`MainAgent.ts:454` e `:465`), então o aviso chega com a resposta já preenchida e nunca é desenhado. `tests/WebMemoryApi.test.ts:157` cobre o snapshot, não a tela.
5. **Sem origem nem chave de tema.** Não dá para distinguir o que o usuário pediu para lembrar do que foi inferido, nem atualizar "onde mora" em vez de duplicar.
6. **Modo JSON e fallback.** Leem o bloco, nunca gravam.
7. **Falhas silenciosas na web.** Ver achado 6.
8. **Sem painel de memória na web.** A API existe; a tela não. Fica fora desta rodada.

### Voz e especialistas

- Voz usa a mesma rota das mensagens digitadas, com `source: "voice"` (`api.ts:393`). No modo tools o modelo responde `<ignore/>` para ruído (`persona.ts:180`); a prévia nunca mostra o marcador (`MainAgent.ts:412`) e o turno não deixa histórico nem memória (`:451`). No modo JSON o equivalente é `{"mode":"ignore"}` (`:240`, `:312`).
- `DevAgent`, `ResearchAgent` e `AgentRenderer` não recebem memória. Eles só veem a tarefa que o MainAgent escreve (`voidTools.ts:90`). Isso está correto para esta fase: o bloco é dado pessoal e o MainAgent decide o que repassar na tarefa. Especialistas também não gravam: a âncora recusa texto que o usuário não disse.

## Ferramentas de interface e workspace

### O que existe

- `initialLayout` é `{ mode: "focus", panel: null, … }` (`src/web/ui-contracts.ts:47`). O Focus mostra só o anel, e isso é intencional: `web/browser/singularity.test.mjs:300` exige zero barra, menu ou compositor na tela inicial, e `docs/ui-runtime.md` diz que recarregar volta ao Focus.
- As operações `ui.openWindow`, `ui.closeWindow`, `ui.switchMode`, `ui.resetLayout` e `ui.render` estão em `src/web/ui-runtime.ts:8`. Desde `ded757a` cada uma tem JSON Schema e resumo em português.
- No modo tools elas chegam ao modelo como `ui_switchMode` etc. (`operationTools`, `voidTools.ts:104`). A execução passa por `AgentRuntime.invokeTool` (`src/runtime/AgentRuntime.ts:17`), que valida chamador e permissão no registro (`AgentRegistry.ts:63`).
- O resultado vira uma ação (`{ type: "switch_mode", mode }`), emitida como mensagem `ui` (`MainAgent.ts:464`), publicada por sessão (`ui-runtime.ts:57`) e entregue no snapshot (`api.ts:168`). O cliente aplica a ação só se ela for do turno que ele mesmo enviou (`console.tsx:257`–`:261`).
- Turnos que produziram ação são marcados `ui = 1` (`MainAgent.ts:454`) e ficam fora do chat, do histórico e do resumo (`ConversationStore.ts:101`, `:155`).

### Por que "abre o workspace" falha

No banco real, sete turnos mencionam o workspace:

| Sessão | Ação de interface produzida | Texto da resposta |
| --- | --- | --- |
| 91c97555 (3 turnos) | 2 de 3 | o que falhou diz que não consegue |
| e6aae685 (1 turno) | sim | afirma que abriu |
| f3a67138 (3 turnos, a mais recente) | **0 de 3** | um afirma que abriu; dois dizem que não conseguem |

Na sessão mais recente nenhum dos três pedidos gerou ação: o modelo respondeu em texto, uma vez afirmando sucesso sem ter chamado a ferramenta. Esse banco foi gerado na `feat/memory`, **antes** de `ded757a`: a ferramenta era anunciada com `parameters: { properties: {} }`, o modelo errava os argumentos e recebia "Argumentos inválidos".

Causa raiz, em duas camadas:

1. Entrar no workspace depende inteiramente de um modelo gratuito emitir uma tool call bem formada. `ded757a` melhora as chances (schema real, regra no prompt), mas não garante.
2. No Focus não há nenhum controle manual para o workspace. A barra com "Focus / Workspace" só existe dentro do próprio workspace (`console.tsx:627`–`:632`), e o overlay de comando do Focus (`:591`–`:610`) só tem o compositor. Quando o modelo falha, o usuário fica preso no anel.

No modo MOCK, só as frases exatas de `src/web/demo-provider.ts:6` funcionam ("modo workspace"); "abre o workspace" recebe a resposta genérica do simulador.

## Escolha de modelo

- **Rota principal.** `VOID_MAIN_MODEL` (com variantes por esforço, `VOID_MAIN_MODEL_HIGH` etc.), padrão `nvidia/nemotron-3.5-super-vl:free` (`modelSelection.ts:83`). Síntese usa `VOID_SYNTHESIS_MODEL`, mesmo padrão.
- **Raciocínio.** Desligado por padrão para o super-vl nas rotas principal e de síntese (`:60`–`:63`).
- **Política gratuita.** `liveModelRoutes` recusa qualquer rota que não seja `openrouter/free` ou `:free` (`:94`). O provedor confere preço zero no catálogo antes de cada chamada (`OpenRouterFreeCatalog.assertFree`, `OpenRouterFreeCatalog.ts:37`) e recusa `tools` quando o modelo não lista esse parâmetro (`OpenRouterProvider.ts:334`).
- **Fallback.** `freeFallbackModels` é super-vl, dots e gemma (`modelSelection.ts:15`). Só entra em falhas de pré-voo e de formato (`OpenRouterProvider.ts:265`), não em 429.
- **Telemetria.** `UsageWindows` (`src/governance/UsageWindows.ts`) e `ProviderUsage` (`src/web/provider-usage.ts`) gravam cada tentativa em `provider_usage` e `provider_attempts`. Foi essa tabela que permitiu responder a pergunta (a).
- **Benchmark existente.** `npm run benchmark:models:live` (`src/examples/benchmarkModels.ts`) mede o coordenador JSON em dois cenários. Não mede tool calling, memória nem interface, que é o que o modo padrão usa hoje.
- **Sem medição registrada.** O padrão atual não tem medição comparativa no repositório para o modo tools.

## Interface web

- `web/app/console.tsx` concentra estado, SSE, voz e os dois layouts. `workspace.tsx` é o painel de operações, `window-manager.tsx` a janela flutuante, `singularity.tsx` o anel e os ícones.
- O rodapé do workspace já diz "OpenRouter · apenas modelos gratuitos" em LIVE (`console.tsx:686`).
- Não existe tela de memória.

## Testes

- Base em `feat/memory` nesta máquina: 282 de 328 passavam. As 46 falhas tinham duas causas alheias ao comportamento: `rmSync` do diretório temporário registrado antes do fechamento do SQLite (EBUSY no Windows) e variantes que forçam `search: "fts5"` num SQLite sem FTS5. Corrigido em `d21aaa8`: 320 passam, 13 são pulados com motivo, 0 falham.
- Os 13 pulados são exatamente os que exercitam FTS5. **O caminho FTS5 não pode ser verificado nesta máquina.**
- O teste instável conhecido de `WebApi` (regex `/999/` contra timestamp) não falhou nas execuções desta rodada.

## Divergências entre o pedido e o código

- O pedido lista os tipos "perfil/preferência/fato/projeto/pessoa/resumo". O código só tem `profile`, `fact` e `summary`.
- O pedido fala em fundir "um" commit `fixup!`. Havia fixtures literais com formato de chave em três arquivos de teste, introduzidas por três commits diferentes; foram necessários três fixups.
- `docs/ui-runtime.md` manda usar o Node "da versão indicada em `.nvmrc`". O arquivo não existe.
- Os commits recentes das branches estão em português; o pedido pede commits em inglês. Os commits desta rodada estão em inglês.
- O pedido descreve o merge como provável fonte de conflitos em cinco arquivos. Só `docs/tool-calling-mode.md` conflitou.

## Depois da auditoria

O texto acima descreve o estado no commit `08c1ac6` e fica como estava. Esta seção registra o estado final da `feat/v2-integration`, depois da especificação completa (fases 2 a 5).

| # | Achado | O que foi feito | Onde |
| --- | --- | --- | --- |
| 1 | Resumo falhava em toda sessão nova | A chamada leva `route.reasoning`. No máximo três tentativas por sessão anterior em cada execução. Os dois modos resumem. Confirmado ao vivo: o resumo passou a ser gravado. | `MainAgent.summarizePrevious` |
| 2 | Workspace dependia só do modelo | Comandos curtos e imperativos de interface rodam no host **antes** do modelo, sem chamá-lo, pelo registro. Controle "Abrir workspace" na própria tela Focus. | `src/web/ui-intents.ts`, `MainAgent.runShortcut`, `console.tsx` |
| 3 | Gravação dependia de `remember` | Agente de memória: uma chamada curta e separada depois da resposta, que propõe operações. As regras fixas rodam sempre depois dele. Tools, agente e regras gravam pelo mesmo caminho. | `memoryAgent.ts`, `memoryExtractor.ts`, `voidTools.ts` (`MemoryStage`) |
| 4 | Aviso de memória invisível na web | O aviso fica embaixo da resposta do turno. Painel "Memória" para ver e apagar. | `console.tsx`, `memory-panel.tsx` |
| 5 | "Anotei." sem gravação | Causa: os exemplos do prompt mostravam a chamada dentro da fala e o modelo copiava a notação. Exemplos reescritos, eco removido. Trava de honestidade: roda o agente na hora e, se nada foi gravado, troca a frase por "Não consegui gravar isso na memória.". O mesmo para ações de interface. | `persona.ts`, `honesty.ts`, `MainAgent.closeTurn` |
| 6 | Falhas de memória silenciosas na web | O runtime web registra as falhas internas no console. `VOID_DEBUG_MEMORY=1` mostra também as gravações e as correções de honestidade, sem texto. | `src/web/runtime.ts`, `MainAgent.diagnose` |
| 7 | Sem FTS5 nesta máquina | Sem mudança de código. Os testes do caminho FTS5 são pulados com motivo. | `tests/support/sqliteTemp.ts` |
| 9 | Modo JSON não gravava | O agente de memória e as regras rodam nos dois modos. Num plano delegado, só uma execução concluída grava. | `MainAgent.closeTurn`, `rememberDelegated` |

Também mudou:

- **Bloco de memória.** Logo depois da persona, antes das regras; no fim do prompt o modelo o ignorava. O enquadramento diz que a memória prevalece sobre mensagens anteriores que disseram não saber.
- **Registros.** Ganharam `origin` (`explicit`, `extracted`, `summary`) e `topic` opcional, com um registro por tema. Bancos existentes migram ao abrir; conferido numa cópia do banco real.
- **Limite de 500.** O resumo mais antigo dá lugar a um fato novo; perfil e fatos nunca saem sozinhos.
- **Modelo.** Conversa e agente de memória no Nemotron 3 Ultra; fallbacks Particle 1, Super VL e Dots; coordenador JSON e síntese no Super VL. Ver `docs/orchestrator-model-eval.md`.
- **Próximo turno espera a gravação.** Um turno da mesma sessão aguarda a captura pendente do anterior antes de chamar o modelo.

### Escolhas feitas por mim

- **Regras fixas além do agente.** A especificação pede o agente de memória e "pular sem erro" quando ele não pode rodar. Mantive também as regras fixas, rodando depois dele, porque a medição mostrou modelos gratuitos devolvendo `[]` para uma mudança de cidade. As duas vias passam pelo mesmo `MemoryStage`, então isso não duplica lógica.
- **Turnos de comando de interface ficam fora do chat.** A especificação pede registrá-los "como qualquer turno". Eles são gravados no histórico, mas com a marca de interface que os turnos de interface do modelo já tinham. Como turnos comuns, eles renomeavam a sessão para "abre o workspace" e quebravam quatro testes de navegador.
- **Rota própria para a conversa.** A especificação pede o vencedor como padrão do MainAgent. Ele virou padrão da conversa (o modo usado em LIVE), não do coordenador JSON, porque não aceita `response_format` e falhou no benchmark do coordenador.

### O que continua em aberto

- O caminho FTS5 não pôde ser exercitado nesta máquina.
- Quase nenhum modelo delega revisão de código a `ask_dev`, e só um respondeu `<ignore/>` a ruído de voz. É ajuste de prompt, não medido nesta rodada.
- A âncora compara palavras, não sentido. A trava de honestidade reconhece formas comuns de afirmar uma gravação ou ação de tela; uma forma que ela não conhece passa.
- O agente de memória com um modelo de raciocínio obrigatório falha sempre (teto de 300 tokens); se `VOID_MEMORY_MODEL` apontar para um deles, só as regras fixas gravam.
