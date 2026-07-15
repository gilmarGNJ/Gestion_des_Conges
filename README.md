# Gestion des congés

Calendário pessoal de férias, RTT e dias de fechamento do CEA Grenoble.

Site principal: [gestion-des-conges-9bbb6.web.app](https://gestion-des-conges-9bbb6.web.app/)

O site inclui:

- saldos anuais de CP e RTT;
- calendário acessível e responsivo;
- histórico estruturado de solicitações de ausência;
- feriados oficiais de 2024 a 2027;
- JRTT impostos do CEA Grenoble confirmados até 2026;
- edição local, exportação/importação JSON e restauração segura;
- sincronização entre dispositivos com login Google e Cloud Firestore.

## Abrir localmente

Como o site usa módulos JavaScript, abra-o por HTTP:

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory public
```

Depois acesse `http://localhost:8765/`. O host `localhost` já está autorizado
no Firebase para desenvolvimento.

## Testes

```powershell
npm test
npm run check
```

Os testes usam dados sintéticos para verificar datas, dias úteis, pedidos,
saldos, migração do cache antigo, importação, limites e sobreposições. Nenhum
dado pessoal é guardado nos testes ou no arquivo público inicial.

## Sincronização e custo

Cada dispositivo deve entrar com a mesma conta Google. O aplicativo grava um
único documento `userCalendars/{uid}`, protegido por regras que autorizam
somente o UID do proprietário.

Pedidos, direitos e limites pessoais ficam apenas no Firestore autenticado (e
na cópia local do navegador usado). O arquivo público contém somente datas
oficiais, fontes e valores iniciais vazios.

O projeto usa o plano Firebase **Spark (US$ 0)**, sem conta de faturamento. O
Firestore oferece 1 GiB de armazenamento, 50 mil leituras e 20 mil gravações
por dia sem custo. No Spark, ultrapassar a cota interrompe o serviço; não gera
cobrança automática. Não vincule uma conta de faturamento, pois isso mudaria o
projeto para o plano Blaze.

Consulte [FIREBASE_SETUP.md](FIREBASE_SETUP.md) para manutenção e publicação.

## Fontes

- [Service Public — jours fériés](https://www.service-public.gouv.fr/particuliers/vosdroits/F2405)
- [Accord CEA Grenoble — fermetures 2024](https://www.maitredata.com/app/accords-entreprise/cea-grenoble/272082)
- [Accord CEA Grenoble — fermetures 2025](https://www.maitredata.com/app/accords-entreprise/cea-grenoble/319016)
- [Accord CEA Grenoble — fermetures 2026](https://www.maitredata.com/app/accords-entreprise/cea-grenoble/368234)

Os JRTT impostos de 2027 ainda não haviam sido publicados em 15/07/2026 e não
são estimados pelo aplicativo.
