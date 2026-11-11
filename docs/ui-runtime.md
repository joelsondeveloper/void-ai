# UI Runtime do VOID

No Focus, clique no anel ou pressione **Ctrl+K** (**⌘K** no Mac). O mesmo fluxo de decisão recebe texto e transcrições de voz.

| Solicitação | Ação |
| --- | --- |
| “Onde posso personalizar você?” | Abre Configurações se a intenção for acessar o painel |
| “Quero trabalhar com minhas conversas e sessões” | Alterna para Workspace |
| “Prefiro voltar ao anel” | Alterna para Focus |
| “Restaure a disposição inicial” | Restaura o layout |

O MainAgent recebe a conversa recente, o catálogo de agentes executáveis e as operações autorizadas. O modelo escolhe entre responder, pedir esclarecimento, executar uma ferramenta ou propor um plano com dependências. O registro valida capacidades, chamadores e argumentos. Uma pergunta informativa, negação ou hipótese pode ser respondida sem executar ação. Os controles manuais do navegador continuam determinísticos. Em LIVE, o despacho por texto ou voz exige um provedor configurado. O provedor MOCK oferece cenários fixos de demonstração.

## Componentes sob demanda

1. O MainAgent escolhe o AgentRenderer para uma etapa `ui-render` quando o pedido exige apresentação visual. O mesmo registro alimenta descoberta, planejamento e execução. A consulta “Quais agentes você possui?” usa esse catálogo.
2. O AgentRenderer tem rota própria. Recebe o objetivo, resultados das dependências e o catálogo da sessão. Decide entre reaproveitar um artefato, montar uma visualização declarativa, pedir detalhes ou delegar TSX ao DevAgent. Abrir um painel nativo ou reabrir uma versão por chave não requer uma chamada ao modelo do Renderer.
3. A delegação usa `AgentInvocation.invoke` e permanece dentro do escopo de permissões, cancelamento e orçamento do plano. O DevAgent valida e compila a proposta sem executá-la no servidor. Quando o Renderer solicita revisão, compara o código com o objetivo e pode pedir uma correção antes de salvar. Falhas de compilação ou truncamento permitem uma tentativa adicional dentro dos limites autorizados.
4. A etapa persiste uma resposta textual e, quando cabível, uma ação estruturada. O Runtime entrega a ação à sessão pelo mesmo canal usado pelos painéis nativos. As versões e a trilha pai–filho ficam no SQLite. Os modelos efetivamente servidos aparecem no checkpoint, com o ID do agente que os acionou.

A prévia abre em iframe de origem opaca e executa o código gerado em um worker dedicado. A árvore React e os eventos passam por um canal restrito. O código pode usar JSX/TSX, componentes próprios, estado, hooks, eventos, formulários locais, SVG, estilos inline, CSS responsivo e animações CSS. Imports estáticos de React e os widgets legados `Counter` e `Toggle` são compatíveis. Cartões, tabelas e barras com eixo zero continuam disponíveis pelo schema declarativo.

O worker fica sem DOM e sem rede. A ponte aceita árvores e eventos limitados, filtra navegação, carregamento de recursos e HTML injetado. O servidor limita o tamanho do módulo. O navegador limita o tamanho e a profundidade da árvore e interrompe um worker sem resposta. O watchdog é um limite de tempo aproximado. O navegador não oferece uma cota rígida de memória por worker. APIs do DOM, armazenamento, dependências externas e acesso ao host ficam fora da prévia.

As versões anteriores permanecem no banco. Estado de formulário fica na janela atual. A ação de abertura é transitória e vinculada à sessão. Recarregar volta ao Focus. O terminal descobre os agentes que o seu canal registra e não possui o Runtime de janelas.

## Validação no notebook

No PowerShell, com Node da versão indicada em `.nvmrc` e Chrome ou Edge instalado:

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run typecheck:web
npm.cmd run build
npm.cmd run build:web
npm.cmd test
$env:VOID_BROWSER_EXECUTABLE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run test:web:browser
```

1. Inicie `npm.cmd run dev:web` e abra `http://127.0.0.1:3030`. Envie “Crie uma interface com um contador de expedições e um checklist de equipamentos”. Incremente e marque o item. Feche a janela e solicite “Reabra a janela do contador de expedições”.
2. Para LIVE, configure `OPENROUTER_API_KEY` localmente, inicie `npm.cmd run dev:web:live` e selecione esforço High. Pergunte “Quais agentes você possui?” e solicite “Crie um painel interativo de despesas, com formulário de lançamento, total e gráfico. Comece sem lançamentos”.
3. Abra Operações e verifique a etapa `agent-renderer` e os modelos servidos por Renderer e DevAgent. Teste o formulário e o gráfico. Na mesma sessão, compare “Abra as configurações”, “Onde posso personalizar você?” e “Não abra as configurações”. Confirme a intenção interpretada e o efeito real na interface.

Os testes Node e de navegador usam respostas de modelo simuladas. O teste da prévia executa o código em Chrome real. Os passos de LIVE exigem credencial gratuita válida e disponibilidade dos modelos.
