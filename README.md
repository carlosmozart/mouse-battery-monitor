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

O nível também aparece em destaque dentro da janela. O app consulta a bateria automaticamente ao conectar e a cada 10 minutos.

Quando a carga atingir 20%, o Windows exibirá um aviso. Um novo aviso será mostrado ao chegar a 10%, sem repetir notificações enquanto o nível permanecer no mesmo limite.
