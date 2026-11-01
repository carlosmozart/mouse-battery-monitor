# Mouse Battery Monitor

App Windows experimental para substituir a página chinesa de configuração/leitura do mouse.

## Rodar

```powershell
npm install
npm start
```

## Primeiro teste com o mouse

1. Conecte o mouse por dongle USB, cabo USB ou Bluetooth.
2. Abra o app com `npm start`.
3. Clique em `Conectar mouse`.
4. Selecione o dispositivo correspondente ao mouse na lista.
5. Aguarde a consulta automática ou clique em `Atualizar`, no cartão da bateria.
6. Abra a seção `Diagnóstico`, no fim da janela, e clique em `Copiar diagnóstico`.

Cole o diagnóstico na conversa para que possamos identificar:

- `vendorId` e `productId` corretos do mouse.
- Quais `featureReports` e `inputReports` o dispositivo anuncia.
- Se o comando de consulta de bateria foi respondido pelo mouse.

## Bandeja do Windows

Depois de iniciado, o app permanece ativo na bandeja do Windows, perto do relógio. Ao fechar a janela, ele apenas fica oculto.

- Clique no ícone azul para reabrir o monitor.
- A bateria desenhada no ícone se preenche conforme a carga: verde acima de 50%, amarela até 21% e vermelha a partir de 20%. Um raio indica que o mouse está carregando.
- O tooltip do ícone mostra o último nível de bateria recebido.
- Clique com o botão direito para abrir o monitor, conectar o mouse ou sair do app.

Na seção de preferências, ative “Iniciar com o Windows”. No próximo login, o monitor abre e aguarda a conexão do mouse autorizado; depois de conectado, a janela é ocultada e o monitor permanece na bandeja. O ícone da bandeja permite reabrir o monitor quando necessário.

A caixa reflete a configuração efetiva do Windows e é atualizada ao voltar para a janela. Se a inicialização tiver sido bloqueada no Gerenciador de Tarefas, reative o monitor em **Configurações → Aplicativos → Inicialização**. O arquivo de preferências de versões anteriores não é mais usado para indicar esse estado. Ao abrir, o app troca a entrada de inicialização criada pelas versões até 0.1.3 pela atual, mantendo a escolha que estava ativa, para não abrir duas vezes no login.

A ocultação automática ocorre somente na primeira conexão do início automático. Reabrir o monitor cancela uma ocultação ainda pendente. Abrir o aplicativo novamente traz a instância existente para a frente.

O nível também aparece em destaque dentro da janela, com a etiqueta “Carregando” quando o cabo está conectado. O app consulta a bateria automaticamente ao conectar, no intervalo escolhido em **Alertas e inicialização** (10 minutos por padrão) e alguns segundos depois de o Windows voltar da suspensão. Abaixo do nível aparece o horário da última leitura.

Se o mouse não responder em 5 segundos (por exemplo, em repouso), a consulta é repetida uma vez. Sem resposta e sem leitura anterior, a janela mostra “Sem resposta”; se já havia leitura, ela é mantida com a indicação “sem resposta agora”. Mova o mouse e clique em `Atualizar`.

Ao desconectar o dispositivo, o app limpa a bateria exibida, mostra o último valor lido e seu horário, e interrompe a consulta periódica. Ao reconectar, ele reavalia as interfaces disponíveis e prioriza a que permite consultar a bateria.

Quando a carga atingir o aviso de bateria baixa (20% por padrão), o Windows exibirá um aviso. Um novo aviso será mostrado ao chegar ao aviso crítico (10% por padrão). Os dois limites são escolhidos em **Alertas e inicialização**, e o crítico precisa ficar abaixo do de bateria baixa. Oscilações em torno desses limites não repetem o alerta; os avisos são rearmados quando a carga passa 5 pontos acima do aviso de bateria baixa ou ao reiniciar o app. Enquanto o mouse carrega, esses avisos não são exibidos.

Ao chegar a 100% durante a carga, o Windows avisa uma vez que o cabo já pode ser desconectado; o aviso pode ser desligado em **Alertas e inicialização**. Ele é rearmado quando a carga cai abaixo de 95%.

As preferências de alerta ficam salvas no perfil do app e valem nas próximas execuções.

## Configurações do mouse

Ao conectar, o app lê o firmware e as configurações gravadas no mouse. Os comandos são os mesmos do configurador oficial do AJ139 V2 MC (`139v2mc.yjx2012.com`):

- **DPI:** seis níveis, de 50 a 24.000 em passos de 50. Marque um nível para ativá-lo na hora; edite os valores e clique em `Aplicar valores de DPI` para gravá-los. A cor ao lado de cada nível é a do indicador no mouse. Trocar o nível pelo botão do próprio mouse atualiza a janela.
- **Iluminação:** Onda, Neon, Flash circular, Bola YoYo, Flash único, Respiração ou Desligado. O mouse não aceita cor personalizada, só esses efeitos. Pelo receptor 2.4G a iluminação pode não acender, segundo o manual.
- **Taxa de polling:** 125, 250, 500 ou 1000 Hz pelo receptor 2.4G. Pelo cabo USB o mouse usa sempre 1000 Hz, e o campo fica bloqueado.
- **Altura de LOD:** 1 mm ou 2 mm.
- **Repouso após:** de 1 a 60 minutos sem uso.

Cada alteração grava a configuração completa que o mouse informou, trocando só o campo escolhido, e depois lê de novo para conferir. Se a leitura não confirmar, a janela avisa. Valores fora dos limites acima não são enviados. Se o mouse não responder à leitura inicial, os controles ficam bloqueados até a próxima conexão.

Clicar em qualquer aviso abre o monitor. As notificações usam o mesmo identificador do instalador (`build.appId`), para aparecerem com o nome do app no Windows.

A permissão HID lembrada entre execuções vale somente para o AJAZZ AJ139 V2 MC. A janela só carrega a página local do app: links externos, novas janelas e conteúdo remoto são bloqueados.

O diagnóstico inclui a versão real do aplicativo. O histórico mantém as 200 entradas mais recentes, com limite de 2.000 caracteres por entrada.

## Testes

Execute `npm test` para verificar seleção de dispositivos, concorrência, desconexão/reconexão, alertas, preferências, protocolo e gravação das configurações do mouse, inicialização e bandeja com simulações de WebHID e Electron. Esses testes não modificam a inicialização do Windows nem acessam o mouse físico.
