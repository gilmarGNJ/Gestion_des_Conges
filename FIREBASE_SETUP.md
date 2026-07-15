# Manutenção do Firebase

O projeto está configurado assim:

- projeto: `gestion-des-conges-9bbb6`;
- plano: **Spark (sem custo e sem faturamento vinculado)**;
- site: `https://gestion-des-conges-9bbb6.web.app/`;
- Firestore Standard: banco `(default)` em `europe-west9` (Paris);
- Authentication: provedor Google;
- Analytics, Gemini e App Hosting: desativados ou não utilizados.

## Publicar

Depois de autenticar a ferramenta oficial do Firebase, execute na raiz:

```powershell
firebase deploy --only firestore:rules,hosting
```

O `firebase.json` publica somente a pasta dedicada `public/`, que contém os
sete arquivos necessários ao site. Antes de cada publicação, confirme que a
saída informa `found 7 files`.

Para publicar apenas a interface:

```powershell
firebase deploy --only hosting
```

Para publicar apenas as regras:

```powershell
firebase deploy --only firestore:rules
```

## Segurança

`public/firebase-config.js` contém somente a configuração pública do aplicativo Web.
Ela não é uma senha. Nunca adicione ao repositório:

- JSON de service account;
- chave privada ou OAuth client secret;
- credenciais do Firebase Admin SDK;
- token produzido por `firebase login`.

As regras aceitam somente o UID explícito do proprietário, exigem token
Firebase válido, limitam o documento aos campos esperados e negam qualquer
outro caminho. Se a conta Google for substituída, entre uma vez, obtenha o novo
UID em **Authentication > Users**, altere `firestore.rules` e publique apenas
as regras.

O arquivo `public/data/seed-data.json` não deve conter pedidos, direitos nem
datas contratuais pessoais. Ele serve apenas para dias oficiais, fontes e um
estado inicial vazio; os dados privados são carregados após a autenticação.

## Custo

Não vincule uma conta de faturamento ao projeto e não selecione **Upgrade** ou
**Blaze**. No plano Spark, nenhuma cobrança é possível sem essa mudança
explícita. Se uma cota gratuita for ultrapassada, o produto é temporariamente
interrompido em vez de cobrar.

Referências oficiais:

- [Planos de preços do Firebase](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)
- [Cotas gratuitas do Firestore](https://firebase.google.com/docs/firestore/pricing)
- [Google Sign-In para Web](https://firebase.google.com/docs/auth/web/google-signin)
- [Security Rules do Firestore](https://firebase.google.com/docs/firestore/security/rules-conditions)
- [API keys do Firebase](https://firebase.google.com/docs/projects/api-keys)
