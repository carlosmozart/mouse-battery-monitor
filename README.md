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
5. Aguarde a consulta automática ou clique em `Atualizar bateria`.
6. Clique em `Copiar diagnóstico`.

Cole o diagnóstico na conversa para que possamos identificar:

- `vendorId` e `productId` corretos do mouse.
- Quais `featureReports` e `inputReports` o dispositivo anuncia.
- Se o comando de consulta de bateria foi respondido pelo mouse.

## Bandeja do Windows

Depois de iniciado, o app permanece ativo na bandeja do Windows, perto do relógio. Ao fechar a janela, ele apenas fica oculto.

- Clique no ícone azul para reabrir o monitor.
- O tooltip do ícone mostra o último nível de bateria recebido.
- Clique com o botão direito para abrir o monitor, conectar o mouse ou sair do app.

Na seção de preferências, ative “Iniciar com o Windows”. No próximo login, o monitor abre e aguarda a conexão do mouse autorizado; depois de conectado, a janela é ocultada e o monitor permanece na bandeja. O ícone da bandeja permite reabrir o monitor quando necessário.

A caixa reflete a configuração efetiva do Windows e é atualizada ao voltar para a janela. Se a inicialização tiver sido bloqueada no Gerenciador de Tarefas, reative o monitor em **Configurações → Aplicativos → Inicialização**. O arquivo de preferências de versões anteriores não é mais usado para indicar esse estado.

A ocultação automática ocorre somente na primeira conexão do início automático. Reabrir o monitor cancela uma ocultação ainda pendente. Abrir o aplicativo novamente traz a instância existente para a frente.

O nível também aparece em destaque dentro da janela. O app consulta a bateria automaticamente ao conectar e a cada 10 minutos.

Ao desconectar o dispositivo, o app limpa a bateria exibida e interrompe a consulta periódica. Ao reconectar, ele reavalia as interfaces disponíveis e prioriza a que permite consultar a bateria.

Quando a carga atingir 20%, o Windows exibirá um aviso. Um novo aviso será mostrado ao chegar a 10%. Oscilações em torno desses limites não repetem o alerta; os avisos são rearmados quando a carga ultrapassa 25% ou ao reiniciar o app.

O diagnóstico inclui a versão real do aplicativo. O histórico mantém as 200 entradas mais recentes, com limite de 2.000 caracteres por entrada.

## Testes

Execute `npm test` para verificar seleção de dispositivos, concorrência, desconexão/reconexão, alertas, inicialização e bandeja com simulações de WebHID e Electron. Esses testes não modificam a inicialização do Windows nem acessam o mouse físico.
