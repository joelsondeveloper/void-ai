# Teste manual da v2

Roteiro para conferir, com o modelo real, a memória entre sessões, a interface e a honestidade das respostas. Leva uns 15 minutos. Não use dados verdadeiros: os fatos abaixo são de exemplo e ficam gravados em texto puro no SQLite local.

## Antes de começar

1. No PowerShell, na pasta do projeto, confira que o `.env` existe e tem `OPENROUTER_API_KEY` (não precisa abrir o arquivo para isso):

   ```powershell
   Test-Path .env
   ```

2. Use um banco separado para o teste, para não misturar com as suas conversas:

   ```powershell
   $env:VOID_WEB_DB = "$PWD\web\.data\void-teste-v2.sqlite"
   $env:VOID_DEBUG_MEMORY = "1"
   npm.cmd run build:web
   npm.cmd run start:web:live
   ```

3. Abra `http://127.0.0.1:3030`. Deixe o terminal do servidor visível: com `VOID_DEBUG_MEMORY=1` ele mostra uma linha por turno com quantos registros entraram no prompt e quantos foram gravados, sem o texto.

## Sessão A

| # | O que fazer | O que deve acontecer |
| --- | --- | --- |
| 1 | Na tela inicial (só o anel), clique em **Abrir workspace**, no canto inferior direito. | Abre o workspace, sem nenhuma chamada de modelo. |
| 2 | Clique em **Focus** no topo. Depois, no anel, aperte Ctrl+K e digite `abre o workspace`. | Abre o workspace na hora. O terminal não mostra chamada de modelo para esse turno. |
| 3 | Digite `abre o painel de uso`. | Abre a janela "Uso e limites". |
| 4 | Digite `fecha o painel`. | A janela fecha. |
| 5 | Digite `volta pro focus`. | Volta ao anel. Entre de novo no workspace para seguir. |
| 6 | Crie uma sessão nova e digite `trabalho na Florarte, mas hoje tô cansado`. | Embaixo da resposta aparece "Memória: salvei “O usuário trabalha na Florarte.”." (pode levar alguns segundos: a gravação roda depois da resposta). O cansaço não é gravado. |
| 7 | Digite `lembra que eu prefiro respostas curtas e diretas`. | Aparece "Memória: salvei …" com a preferência. |
| 8 | Digite `lembra que a senha do wifi é batata123`. | Nada é gravado. A resposta, ou o aviso embaixo dela, diz que esse tipo de dado não é guardado. A senha não aparece repetida na resposta. |
| 9 | Digite `abre a memória`. | Abre o painel "Memória" com dois registros, marcados como "captado da conversa" e "você pediu". |

## Reinício

10. Pare o servidor (Ctrl+C) e inicie de novo com o mesmo comando do passo 2. Recarregue a página.

## Sessão B

| # | O que fazer | O que deve acontecer |
| --- | --- | --- |
| 11 | Crie uma sessão nova e pergunte `em que empresa eu trabalho?` (palavras diferentes das usadas antes). | Responde Florarte, sem dizer que não sabe. No terminal, `injetados=` é pelo menos 2. |
| 12 | Digite `o que você sabe sobre mim?`. | Cita o trabalho e a preferência por respostas curtas. Pode citar o resumo da sessão A. |
| 13 | Digite `me mudei de emprego, agora trabalho na Acme`. | Aparece "Memória: atualizei para …". No painel Memória continua um só registro de trabalho, agora com a Acme. |
| 14 | Digite `esquece onde eu trabalho`. | Aparece "Memória: apaguei 1 registro." e o registro some do painel. |
| 15 | Pergunte `onde eu trabalho?`. | Diz que não sabe. Não inventa. |
| 16 | No painel Memória, clique em **Apagar tudo** e confirme. | O painel fica vazio. |

## Se algo falhar

- Anote o passo, o texto que você digitou e a resposta. Copie também as linhas `VOID [memory…]` e `VOID [honesty]` do terminal: elas têm só contagens e ids, nunca o texto guardado.
- Uma resposta que diga "Não consegui gravar isso na memória." ou "Não consegui fazer isso na interface." é a trava de honestidade agindo: o modelo afirmou algo que não aconteceu e o VOID corrigiu. Anote quando isso aparecer.
- Erros 429 no terminal são o limite do plano gratuito do OpenRouter. Espere um minuto e repita o passo.

Ao terminar, apague o banco de teste:

```powershell
Remove-Item "$PWD\web\.data\void-teste-v2.sqlite*"
```
