---
name: criar-agente
description: Cria ou integra um agente no VOID/Singularity OS, do contrato e registro até a capacidade verificável no canal que vai usá-la.
---

# Criar agente no VOID

Criar um agente significa integrá-lo ao sistema inteiro. A entrega exige uma capacidade alcançável por um chamador autorizado e validada pelo ponto de entrada real.

## Procedimento

1. Inspecione `src/types/agent.ts`, `src/runtime/AgentRegistry.ts`, `src/runtime/AgentRuntime.ts` e o bootstrap do canal alvo. Na web, comece por `src/web/runtime.ts`. Defina ID estável, nome, descrição fiel, responsabilidade, limites e chamadores.
2. Escolha a interface. Use `ExecutableAgent.execute(AgentTask, AgentContext)` para etapas de plano com saída textual. Use `AgentOperation<Input, Output>` para operações especializadas ou resultados estruturados. Nesse caso, implemente a identidade `AgentIdentity` e o handler. Valide dados externos na fronteira antes de invocar a operação.
3. Registre a identidade no bootstrap antes das operações. Declare os chamadores de cada operação em `registerOperation`. Execute via `AgentRuntime` ou `context.invoke` para preservar contexto, permissões, cancelamento, orçamento e rastreamento. Evite chamadas diretas a handlers e conversões de resultado estruturado em texto.
4. Derive as capacidades disponíveis de `AgentRegistry.catalog(caller, permissions)`. O catálogo separa `planCapabilities` de `operations`. Declare capacidades de plano na definição e capacidades tipadas no token da operação. Se o modelo precisar acionar uma operação tipada, declare em `AgentOperation.tools` seu nome único, descrição, exemplo, `accepts` (validador JSON estrito) e `prepare` (conversão para a entrada tipada com recursos confiáveis). `AgentRegistry.toolCatalog` alimenta o contexto e `AgentRuntime.invokeTool` resolve a mesma operação para execução. Não adicione um switch no MainAgent nem filtros de palavras para disponibilizar a ferramenta. Retorne `{ response, action? }` no canal conversacional; valide a ação pelo contrato do UI Runtime. Preserve a autorização por chamador e não copie listas de agentes no prompt.
5. Conecte prompts, contexto, ferramentas e rotas de modelo quando aplicável. Reutilize a governança de custo e tempo. Trate a saída do modelo como dados. Mantenha as permissões concedidas pelo bootstrap ou pela política do usuário. A exposição no catálogo não concede acesso a ferramentas privilegiadas.
6. Integre o serviço, persistência e entrega no canal alvo. Em UI, valide a ação e use o UI Runtime e o Window Manager. Para código gerado, reutilize compilação, versões e prévia isolada. Preserve os fluxos já disponíveis.
7. Teste o contrato, as permissões e pelo menos um caminho de falha. Teste descoberta e despacho pelo bootstrap real, incluindo um agente novo sem alterações no MainAgent. Cubra paráfrases, perguntas e negações com decisões simuladas e distinga esses testes de avaliação semântica com modelo LIVE. Faça o teste ponta a ponta pelo canal alvo. Para UI, confirme o efeito no navegador. Documente o que a capacidade faz, como acioná-la e os limites verificados.

## Exemplos

- **ResearchAgent** implementa `ExecutableAgent`. O MainAgent pode escolher `comparative-analysis` em um plano quando essa capacidade aparece no catálogo autorizado.
- **AgentRenderer** registra identidade e a operação tipada `renderWindow`, chamada pelo MainAgent após validar `ui.render`. Ele usa `context.invoke(authorComponent, input)` para acionar o DevAgent. A saída é uma ação de janela entregue ao navegador. `ui-author` pertence ao DevAgent e é visível a quem pode invocá-la.

## Checklist

- [ ] Identidade, responsabilidade, contratos e limites definidos.
- [ ] Implementação registrada no bootstrap e descoberta pelo chamador certo.
- [ ] Runtime, contexto, permissões e orçamento aplicados pelo caminho real.
- [ ] Serviço, ferramenta, UI e persistência conectados onde aplicável.
- [ ] Testes de contrato, integração e fluxo ponta a ponta executados.
- [ ] Capacidade documentada com evidência, limitações e testes pendentes.
