# Guia de Configuração — Meta Ads MCP Server

Este guia explica como obter as credenciais necessárias para conectar o Claude à Meta Marketing API.

## Pré-requisitos

- Conta no Facebook com acesso a uma conta de anúncios (Ad Account)
- Conta de desenvolvedor Meta

## Passo 1: Criar conta de desenvolvedor

1. Acesse [developers.facebook.com](https://developers.facebook.com/)
2. Faça login com sua conta Facebook
3. Aceite os termos de desenvolvedor

## Passo 2: Criar um App

1. No painel de desenvolvedor, clique em **"Criar App"**
2. Selecione o tipo **"Business"** (Negócios)
3. Preencha o nome do app e email de contato
4. Clique em **"Criar App"**

## Passo 3: Adicionar a Marketing API

1. No painel do app, vá em **"Adicionar Produtos"**
2. Encontre **"Marketing API"** e clique em **"Configurar"**
3. Isso habilita o acesso à API de anúncios

## Passo 4: Gerar Access Token

### Opção A: Token de teste (curta duração — para desenvolvimento)

1. Acesse o [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Selecione seu App no dropdown
3. Clique em **"Generate Access Token"**
4. Adicione as permissões: `ads_management`, `ads_read`
5. Copie o token gerado

### Opção B: System User Token (longa duração — recomendado para produção)

1. Acesse [Business Manager](https://business.facebook.com/settings/)
2. Vá em **Configurações > Usuários do Sistema**
3. Crie um novo System User com papel **Admin**
4. Atribua o ativo (Ad Account) ao System User
5. Gere um token com permissões `ads_management` e `ads_read`

## Passo 5: Obter Ad Account ID

1. Acesse o [Ads Manager](https://www.facebook.com/adsmanager/)
2. O ID da conta aparece na URL ou nas configurações da conta
3. O formato é `act_XXXXXXXXXX`

## Passo 6: Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite o arquivo `.env` com suas credenciais:

```
META_APP_ID=seu_app_id
META_APP_SECRET=seu_app_secret
META_ACCESS_TOKEN=seu_access_token
```

## Passo 7: Verificar conexão

```bash
pip install -r requirements.txt
python verify_setup.py
```

## Passo 8: Usar com Claude

Com o `.mcp.json` configurado e as variáveis de ambiente definidas, o Claude terá acesso às seguintes capacidades via MCP:

- **Relatórios**: "Mostre o CPA e ROAS das minhas campanhas dos últimos 7 dias"
- **Gestão**: "Crie uma campanha de conversão com budget de R$100/dia"
- **Regras**: "Pause todos os ad sets com CPA acima de R$50"
- **Criativos**: "Liste todos os criativos ativos e seus CTRs"

## Solução de problemas

| Erro | Solução |
|------|---------|
| Token expirado | Gere um novo token (Passo 4) |
| Permissão negada | Verifique se o token tem `ads_management` e `ads_read` |
| Ad Account não encontrado | Confirme o ID no formato `act_XXXXXXXXXX` |
| App não aprovado | Submeta o app para revisão no painel de desenvolvedor |
