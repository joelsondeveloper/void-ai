# UI Runtime do VOID

O navegador inicia em Focus, com o anel no centro. Clique ou toque no anel para acessar texto e voz, ou pressione **Ctrl+K** (**⌘K** no Mac). Digite ou diga **modo workspace** para abrir a interface com sessões, conversa e operações. Para voltar ao anel, use **voltar ao focus**.

## Comandos de interface

| Experimente dizer ou digitar | Resultado |
| --- | --- |
| `Modo Workspace` / `volte ao Focus` | Alterna o modo |
| `Mostre as configurações` | Abre os ajustes de voz e esforço |
| `Abra o painel de uso` | Abre a telemetria dos provedores |
| `Abra as sessões` | Abre o arquivo de sessões |
| `Mostre as operações` | Abre o painel da execução |
| `Resetar layout` | Volta ao Focus e descarta a visualização atual |

As janelas flutuam sobre o anel e usam os painéis reais do VOID. Arraste pelo título ou redimensione pelo canto inferior direito. Use os controles do título para maximizar, restaurar, minimizar ou fechar. O botão que aparece após minimizar restaura a janela. **Esc** fecha primeiro a entrada de comando, se aberta, ou fecha a janela. Abrir outro painel substitui o anterior. Configurações pausa a escuta enquanto estiver visível.

## Visualizações

No modo LIVE, um pedido explícito como “Crie um gráfico de barras com janeiro 10 e fevereiro 15” pode receber um schema da mesma decisão do MainAgent que atende à conversa. A versão simulada e o modo LIVE também aceitam um schema fornecido diretamente. Esse caminho é local e determinístico.

```text
Exibir {"title":"Receitas","blocks":[{"kind":"card","title":"Total","value":25},{"kind":"table","title":"Meses","columns":["Mês","Receita"],"rows":[["Janeiro",10],["Fevereiro",15]]},{"kind":"bar_chart","title":"Receita mensal","points":[{"label":"Janeiro","value":10},{"label":"Fevereiro","value":15}]}]}
```

O renderer aceita cartões, tabelas e barras com eixo zero. O contrato limita títulos, campos, tamanhos, números finitos, blocos, linhas e colunas. O conteúdo entra como texto e números em componentes React registrados. O schema não aceita HTML, URLs de recursos, atributos de evento, estilos ou código.

## Integração e limites

- O MainAgent encaminha os comandos locais de texto e voz à mesma ferramenta. Comandos inequívocos funcionam mesmo quando o provedor de modelos está indisponível. A ação aparece na interface e fica fora do chat e da leitura em voz alta.
- Pedidos mais complexos que mencionam um painel podem resultar em `{"mode":"tool","call":{"name":"ui.openWindow","arguments":{"component":"settings"}}}`. A ferramenta também aceita `ui.closeWindow`. O contrato aceita apenas Configurações, Uso, Sessões e Operações e rejeita componentes ausentes do pedido e campos extras. A ferramenta não altera preferências nem executa operações dentro do painel.
- `open_panel`, `close_panel`, `switch_mode`, `update_panel`, `open_component` e `reset_layout` compartilham o contrato e o redutor com os controles manuais. O único painel com conteúdo atualizável por schema é `display`.
- A API usa as mesmas verificações de origem e de sessão da conversa. O snapshot SSE leva a última ação transitória de cada sessão recente. O navegador valida a ação e aplica apenas a que corresponde ao envio pendente nessa aba. Um reload inicia em Focus e mantém a conversa, sem reabrir um painel antigo.
- O schema do modelo só é aceito quando o pedido atual começa com uma solicitação explícita de visualização. Confirme os dados em visualizações montadas pelo modelo.
## Componentes sob demanda

**Quais agentes estão disponíveis?** consulta o registro autorizado, inclusive em LIVE sem chave. O AgentRenderer aparece no canal web por oferecer operações de janela. O terminal anuncia as capacidades que seu próprio bootstrap registra.

No Focus, pressione **Ctrl+K** e envie **Crie uma interface com um contador de expedições e um checklist de equipamentos**. Esse pedido tem um cenário de modelo simulado em MOCK. Em LIVE, o MainAgent e o DevAgent usam as rotas gratuitas já configuradas. Quando a janela abrir, clique em **+** e marque o item do checklist. Envie **Reabra a janela do contador de expedições** na mesma sessão para reutilizar a versão salva.

1. O MainAgent oferece `ui.render` ao modelo para pedidos de interface. A decisão aceita JSON com um pedido, uma chave de catálogo opcional, um schema declarativo opcional e a indicação opcional de revisão. Ele fornece ao modelo os títulos e as chaves dos componentes recentes da sessão.
2. O AgentRenderer resolve um painel nativo, compõe cartões, tabelas e gráficos ou procura um artefato compatível pela chave da sessão. Sem um artefato reutilizável, invoca o DevAgent pelo AgentRuntime. O registro autoriza cada relação entre chamador e especialista. O runtime propaga o contexto e o cancelamento, contabiliza tarefas, recusa ciclos e grava a relação pai–filho no SQLite.
3. O DevAgent produz um componente TSX, valida o código, compila e faz uma renderização de teste com React. Pode pedir uma correção após uma falha de validação, dentro do saldo de chamadas, tokens e tempo. Quando há truncamento, o fluxo pode repetir a decisão visual em formato compacto e o DevAgent pode tentar uma versão menor. Cada etapa tem no máximo uma nova tentativa dentro do orçamento, sem ampliar o teto configurado nem mudar para uma rota paga. Ele salva a origem e o resultado compilado e devolve a referência versionada. O SQLite guarda o título, a versão, a permissão de prévia, a sessão, a tarefa autora, a data e o resumo criptográfico do artefato.
4. O AgentRenderer devolve a especificação da janela ao canal de ações do UI Runtime. O Window Manager abre uma prévia em um iframe com origem opaca e política de conteúdo restritiva. O JavaScript compilado cria o componente React na prévia. O contador e o checklist mantêm estado enquanto a prévia está aberta. A ação fica fora da conversa e da leitura em voz alta.

### Escopo desta fase

- A prévia aceita um subconjunto de TSX com tags e atributos permitidos e dois widgets com estado local, `Counter` e `Toggle`. A validação recusa código fora desse contrato, incluindo importações, expressões arbitrárias, atributos de eventos e recursos externos. A prévia executa sem acesso à rede, ao DOM do VOID, ao armazenamento da origem, a credenciais ou a ferramentas do host.
- Uma revisão mantém as versões anteriores no banco. Reabertura e revisão usam a chave da sessão ou, na ausência dela, a descrição normalizada. Os dados preenchidos nos widgets não são persistidos. O catálogo usa correspondência por chave e descrição, com os títulos recentes para orientar a decisão do modelo.
- A criação termina no artefato registrado localmente. Ficam para uma próxima fase a inspeção de versões pela interface, a exposição das subtarefas visuais em Operações, a retomada de uma geração interrompida, widgets adicionais e qualquer capacidade privilegiada. Alterações de arquivos do projeto, acesso a segredos e publicação exigiriam ferramentas e autorização próprias.
- Os testes Node simulam as respostas do modelo, inclusive uma tentativa inválida seguida de correção. O teste no Edge usa respostas simuladas em MOCK e executa o componente React compilado de fato no navegador.
