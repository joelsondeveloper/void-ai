---
name: criar-agente
description: Cria ou integra um agente no VOID/Singularity OS, do contrato e registro até a capacidade verificável no canal que vai usá-la.
---

# Criar agente no VOID

1. Implemente `ExecutableAgent.execute(task, context)` para participar do planejamento. Declare ID estável, nome, descrição fiel e capacidades em `definition`. Retorne `{ content }` e uma ação validada do UI Runtime quando a etapa produzir uma janela. Identidades sem `execute` servem apenas para operações tipadas.
2. Registre a instância no bootstrap do canal. Na web, use `src/web/runtime.ts`. Derive as permissões da política do host. `AgentRegistry.catalog` expõe capacidades executáveis e operações autorizadas. A validação e o executor resolvem IDs e capacidades pelo mesmo registro.
3. Para um agente cognitivo, declare `definition.model` com `configKey` e `fallback` gratuito. O bootstrap monta as rotas por agente a partir do registro. Leia `context.modelRoute` e use `ModelRouter` no escopo da execução. Por exemplo, `configKey: "RENDERER"` lê `VOID_RENDERER_MODEL` e variantes por esforço. Mantenha a política de custo zero.
4. Declare ferramentas e delegações como `AgentOperation<Input, Output>`. Registre o proprietário e os chamadores permitidos. Para uma ferramenta do modelo, declare nome, descrição, exemplo, validador de argumentos e preparação com recursos confiáveis. Use `context.invoke` para delegar e `AgentRuntime.invokeTool` para despachar. O runtime aplica limites, autorização, prevenção de ciclos, cancelamento e rastreamento pai–filho.
5. Trate objetivos, resultados e rótulos persistidos como dados. Valide saídas do modelo e efeitos na fronteira. Preserve a sessão, o isolamento da prévia e a autorização por capacidade. Use ações e referências tipadas para comunicar a UI. O checkpoint mantém a rota, o modelo servido, a saída e a categoria da falha.
6. Teste a descoberta no canal real, a seleção no plano, as permissões, a delegação, o cancelamento e ao menos uma falha. Exercite paráfrases, negações e ambiguidade no caminho de decisão. Execute os testes de navegador para efeitos visuais e registre quais respostas foram simuladas e quais passaram por modelo LIVE.

O AgentRenderer é um exemplo de agente com etapa cognitiva, delegação tipada ao DevAgent e entrega de uma ação estruturada. Registrar um agente adicional não exige alterar o MainAgent, o executor, o frontend ou a validação de checkpoints.
