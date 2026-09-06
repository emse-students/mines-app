# Workflow de developpement Canari

> Pour le mainteneur du projet. Ce qu'il faut faire soi-meme, ce que la machine fait toute seule, et
> dans quel ordre.

Ce guide est la seule copie de la marche a suivre. Les mecanismes sont documentes ailleurs et les
liens y renvoient : [`docs/wiki/cicd.md`](../wiki/cicd.md) pour la chaine complete,
[`docs/wiki/workflow-migration.md`](../wiki/workflow-migration.md) pour les decisions du 2026-09-02
et leurs raisons, [`docs/wiki/infrastructure/dev-environment.md`](../wiki/infrastructure/dev-environment.md)
pour la seconde estate, [`infrastructure/MIGRATION.md`](../../infrastructure/MIGRATION.md) pour les
secrets.

> **Ce fichier a ete entierement reecrit le 2026-09-03.** Ce qu'il decrivait avant - pousser
> directement sur `main`, un push qui deploie les deux estates a la suite, une branche `dev` -
> n'existe plus. Si une phrase d'ailleurs contredit celle-ci, c'est l'autre qui est perimee.

---

## 1. Les trois regles, et tout le reste en decoule

1. **`main` est la seule branche.** Elle est protegee : pas de push direct, pas de force-push, pas
   de suppression. Le travail arrive par **pull request**.
2. **Rien ne se deploie a un push.** Ni a un merge. Fusionner une correction ne la livre pas.
3. **Le deploiement se fait au bump** : publier une release est la seule chose qui deploie quoi que
   ce soit, et c'est la nature de la release qui decide **ou**.

| Ce que tu publies | Ce que ca deploie | Ce que ca envoie aux stores |
|---|---|---|
| `vX.Y.Z-alpha.N` (pre-release) | `dev.canari-emse.fr` | les programmes de **testeurs** : piste `internal` sur Play, TestFlight sur iOS |
| `vX.Y.Z` (release stable) | la **production** | Play piste `production`, deploiement complet ; l'`.ipa` part sur App Store Connect |
| rien (un simple merge) | rien | rien |

**Ce qui distingue les deux, c'est le tiret dans le numero de version.** Pas une case a cocher sur
GitHub, pas une branche : `build.yml` relit la version dans `frontend/package.json` apres le bump, et
un tiret dedans **est** la definition d'une pre-release. Le meme test est dans
`scripts/bump-app-version.sh`. Une seule source de verite, donc pas de desaccord possible entre ce
qui est construit et ce qui est deploye.

---

## 2. Le quotidien : tout se developpe en LOCAL

Il n'y a plus aucune raison de pousser pour voir un changement tourner. L'estate locale est
complete - les 4 services NestJS, les 2 services Rust, Postgres, Redis, Garage, et **nginx**, qui
est le seul point d'entree exactement comme en production.

```bash
make run-services                 # la stack Docker locale
cd frontend && bun run dev        # le frontend, en HMR
```

**L'authentification fonctionne en local**, jusqu'a la connexion OIDC complete et l'envoi d'un
message MLS chiffre entre deux clients. C'est ce qui rend cette section credible : ce n'est pas une
maquette qui compile, c'est l'application qui marche.

**nginx est le seul authentificateur, en local comme en production.** Il valide le jeton
(`auth_request`), pose `X-User-Id`, et les services ne lisent que cet en-tete. Passer a cote de
nginx et taper un service directement ne teste donc rien de ce que l'application fait vraiment.

Avant chaque commit :

```bash
cd frontend && bun run check && bun run lint && bun run format
```

Le hook de pre-commit balaye tout le frontend (2-3 min) et re-stage le resultat. Ne jamais le
contourner : si un hook echoue, la cause se corrige. Pour la chaine complete en local :
`make run-ci`. Pour les tests : `make test`.

---

## 3. Livrer : la pull request

```bash
git switch -c fix/description-courte
# ... travail, commits ...
git push -u origin HEAD
gh pr create
# c'est tout. Elle se merge toute seule quand "CI passed" est vert.
```

**Le geste humain, c'est OUVRIR la pull request - pas la fusionner.** Ce qui se passe ensuite, dans
l'ordre :

| # | quand | ce qui se passe |
|---|---|---|
| 1 | a l'ouverture | **deux workflows partent en parallele sur le meme evenement**. `auto-merge.yml` arme l'auto-merge de GitHub (5 secondes) ; `ci.yml` demarre |
| 2 | dans `ci.yml` | `Detect changes` lit les chemins modifies et decide quels jobs tournent, puis ceux-la tournent en parallele : Rust (5 crates), `Boot the real AppModule` (4 services NestJS), tests TS, frontend (vitest + lint + `svelte-check` + build), self-tests du banc d'essai, self-tests des scripts CI |
| 3 | a cote, **non obligatoires** | CodeQL, recherche de secrets, audit des vulnerabilites de dependances |
| 4 | quand tout est fini | **`CI passed`** agrege les resultats. `success` **et** `skipped` passent ; `failure` et `cancelled` non |
| 5 | `CI passed` vert | **GitHub fusionne tout seul**, en squash, et supprime la branche. Aucune approbation |
| 6 | la fusion atterrit sur `main` | elle **declenche un evenement `push`**, donc `ci.yml` retourne une deuxieme fois, sur le `main` reellement fusionne |
| 7 | ensuite | **rien**. Aucun deploiement, aucun store, aucun bump de version |

**L'etape 2 ne teste pas ta branche : elle teste la FUSION.** GitHub fabrique un commit
`Merge <ta branche> into <main>` et c'est celui-la qui est teste - deux pull requests qui passent
chacune peuvent quand meme casser `main` entre elles.

**L'etape 6 n'est pas un detail, c'est ce qui rend une release possible plus tard.** La fusion est
faite par l'App `canari-auto-merge`, et une fusion faite par une App **declenche** un `push` la ou
une fusion faite par `GITHUB_TOKEN` n'en declenche pas (regle anti-recursion de GitHub). C'est ce
run-la qui pose le controle `CI passed` **sur le commit de `main`** - et c'est exactement ce que la
troisieme porte du preflight de release ira relire. Si l'auto-merge etait arme avec le jeton par
defaut, `main` n'aurait jamais de run, donc jamais de `CI passed`, et **toutes les releases seraient
refusees** sur des commits qui avaient pourtant ete testes.

**Si tu repousses sur la branche**, tout recommence : l'auto-merge se re-arme (deja arme = succes,
pas une erreur) et la CI retourne sur le nouveau commit de fusion.

**Trois cas ou l'auto-merge ne s'arme pas**, volontairement : un brouillon (*draft*), une pull
request de Dependabot (elle a son propre plafond, qui existe parce que `postgres 15 -> 18` est passe
sur une suite entierement verte et a coupe la production 33 minutes), et une contribution
exterieure.

**Aucune approbation n'est requise.** C'est delibere et c'est ta propre regle : *"Je prefere blinder
de test et faire les choses automatiquement qu'avoir une revue humaine qui n'arrive jamais."* Une
file d'attente que personne ne vide est pire que la fusion qu'elle empeche. La pull request est la
pour deux choses que le push direct ne donnait pas : un diff lisible, et un run de CI sur le
resultat **fusionne** plutot que sur la branche seule.

**Un seul controle est obligatoire : `CI passed`.** C'est un job d'agregation qui verifie que tous
les autres ont reussi ou n'avaient rien a faire. Il ne pouvait pas y en avoir d'autre : chaque vrai
job de `ci.yml` est derriere un filtre de chemins, et un controle obligatoire qui est *saute* soit
bloque la fusion pour toujours, soit passe pour rien. Sur une pull request qui ne touche que de la
documentation, `CI passed` est vert en quelques secondes.

**La sortie de secours existe.** Le role administrateur contourne la regle, donc un `CI passed`
casse ne peut pas verrouiller le depot. La prendre veut dire que la production est en train de
bruler ; ca se note dans `CHANGELOG.md` quand ca arrive.

### 3.1 Apres la fusion : la branche disparait sur GitHub, PAS chez toi

**Un arbre local encombre ne dit RIEN sur la fusion**, et c'est la confusion a evacuer en premier
parce qu'elle se represente a chaque pull request. Ce que GitHub supprime, c'est la branche
**distante** (le reglage `delete_branch_on_merge`). Rien sur GitHub ne peut supprimer une branche
dans ton depot local : cote serveur elle n'existe plus, chez toi elle est toujours la, et `git
branch` continue de l'afficher.

Comment lire l'etat reel en une commande :

```bash
git fetch --prune          # supprime les references de suivi vers des branches disparues
git branch -vv             # les branches locales dont l'amont a disparu sont marquees ": gone]"
```

Une ligne marquee `[origin/ma-branche: gone]` veut dire exactement une chose : **la fusion a
fonctionne et GitHub a fait le menage**. C'est le signe du succes, pas d'un probleme.

Pour ranger, une fois que tu as verifie que la pull request est bien `MERGED` :

```bash
git switch main && git pull --ff-only
git branch -D ma-branche
```

**`-D` et non `-d`, et ce n'est pas de la brutalite.** La fusion est un *squash* : le contenu de ta
branche est dans `main`, mais son commit n'en est pas un ancetre. `git branch -d`, qui verifie
l'ascendance, refuse donc une branche parfaitement fusionnee. La vraie preuve n'est pas
l'ascendance, c'est l'etat de la pull request - `gh pr list --head ma-branche --state all` doit
dire `MERGED`.

---

## 4. Deployer : publier une release

**Une seule action manuelle : creer la release sur GitHub.** Tout le reste s'enchaine.

1. **Releases -> Draft a new release**, cible `main`.
2. Le tag : `vX.Y.Z-alpha.N` pour une pre-release, `vX.Y.Z` pour une stable (le `v` compte).
3. **Cocher "Set as a pre-release" pour une alpha.** C'est la seule etape ou une distraction coute
   quelque chose, et pas tout de suite - voir 4.1.
4. Publier.

Ensuite, sans intervention :

**Tout se passe dans UN SEUL run**, `Release` (`release.yml`), et dans cet ordre :

| etape | ce qui se passe |
|---|---|
| `preflight` | cinq verifications. **Si l'une refuse, rien ne bouge du tout** : pas de bump, pas de deploiement, aucun store. Voir 4.0 |
| `bump` | ecrit la version dans `package.json`, les `Cargo.toml`, la config Tauri et le projet iOS, calcule les numeros de build des stores, pousse sur `main`, et **fixe le commit** que les trois bras ci-dessous construiront |
| `build.yml` | reconstruit ce qui a change depuis la release **de meme nature**, pour l'estate qu'on lui nomme |
| `serve-dev.yml` | deploie `dev.canari-emse.fr`. Appele pour une alpha, jamais pour une stable |
| `serve-prod.yml` | deploie la production. Appele pour une stable, et seulement une fois les DEUX stores servis |
| `android.yml` | `.aab` signe -> Play, piste `internal` pour une alpha, `production` pour une stable |
| `ios.yml` | `.ipa` -> App Store Connect via `altool`. Pour une **alpha**, ca s'arrete la et les testeurs internes voient le build. Pour une **stable**, la version App Store est creee, le build y est rattache, les notes sont ecrites et **le tout est soumis a validation Apple** - plus aucun geste manuel |

### 4.0 Les cinq refus possibles, et ce qu'il faut faire de chacun

Aucun n'est contournable par un drapeau : un contournement serait un chemin de repli, et emprunter
un chemin de repli veut dire que le chemin principal est casse. Le vrai chemin d'urgence n'est pas
logiciel - c'est un humain avec les droits admin, et ca s'ecrit dans `CHANGELOG.md` quand ca arrive.

| le refus | ce qu'il faut faire |
|---|---|
| la version n'est pas une version | supprimer la release, la republier avec un tag lisible (`v0.16.0` ou `v0.16.0-alpha.1`) |
| le commit n'est pas sur `main` | passer par une pull request - rien ici ne deploie un commit que le tronc ne porte pas |
| `CI passed` n'est pas vert **sur ce commit** | reparer les tests. Un check **absent** est refuse aussi : ce n'est pas un check qui passe |
| **la prod serait en avance sur dev** (stables seulement) | publier d'abord une **pre-release sur ce meme commit**. Elle deploie dev en quelques minutes et deplace le repere que cette verification lit ; republier la stable ensuite |
| les notes de version ne nomment pas cette version | reecrire `store/whats-new.txt`, **premiere ligne `version: X.Y.Z`**, puis republier |

### Le changelog : un seul texte, trois destinations

`store/whats-new.txt` est le seul texte qu'une version stable te demande d'ecrire. Sa premiere ligne
doit etre `version: X.Y.Z` - c'est ce qui empeche une release de publier en silence les notes de la
precedente, et la cinquieme barriere refuse la release en quelques secondes si elle ne correspond
pas.

**Depuis le 2026-09-03 ce texte part aux trois endroits, et tu ne l'ecris qu'une fois :**

| Destination | Ce qui s'y passe |
| --- | --- |
| App Store | ecrit dans **chaque** langue de la fiche, puis la version est envoyee en revue |
| Google Play | ecrit pour `fr-FR` et `en-US`, les deux langues de la fiche - **Play ne recevait rien du tout avant** |
| Release GitHub | ajoute au corps de la release, entre deux marqueurs |

**Tu peux laisser la case "description" de la release GitHub VIDE** : elle est remplie pour toi. Si
tu y ecris quelque chose, ce que tu as ecrit est garde et les notes viennent en dessous - rien de ce
que tu tapes n'est ecrase, et republier n'ajoute pas une deuxieme copie.

**Une pre-release ne porte pas ces notes**, et ce n'est pas un choix : le fichier nomme la version
STABLE, donc il ne peut pas decrire une `alpha`. C'est la stable qui suit qui documente tout.


Le quatrieme est la raison d'etre du fichier : *"Je ne veux pas un detecteur de retard, je ne veux
pas que ca soit possible."* Il n'y a donc pas de rapport a lire - il y a un refus.

Le cinquieme est la seule chose qu'un humain **doit** ecrire a chaque stable. Apple refuse une
soumission sans notes de version ; les lui laisser decouvrir a la fin d'une release couterait toute
la release (bump fait, production deployee, Play publie, vingt minutes de build macOS), donc c'est
verifie en quelques secondes avant que quoi que ce soit ne bouge. **La premiere ligne nomme sa
version** parce qu'un simple "le fichier n'est pas vide" passerait indefiniment sur des notes que
personne n'a mises a jour, et le store afficherait celles de la release d'avant.

### 4.1 La case "pre-release" et le numero de version ne peuvent plus se contredire

**Ce paragraphe decrivait un piege jusqu'au 2026-09-03. Il n'en est plus un, et il vaut la peine de
savoir pourquoi.**

Deux choses disent si une release est une pre-release : le **tiret dans la version**, et la **case
"Set as a pre-release"**. Ce sont deux affirmations independantes tapees sur le meme formulaire, et
tant que la seule chose lue etait la version, une contradiction ne se voyait pas :

| ce que tu fais | ce qui se passait avant |
|---|---|
| cocher la case sur un `v0.17.0` | la **production** etait deployee, sans un mot |
| oublier la case sur un `v0.17.0-alpha.1` | un build **testeur** partait sur les deux canaux de production |

Aucun des deux n'est visible dans un run vert, et le second coutait plus tard : une alpha rangee
parmi les stables devient la reference du **detecteur de changements** pour la prochaine stable -
une reference trop recente, donc des services non reconstruits alors qu'ils ont change. Ca se
manifeste une release plus tard, loin de sa cause.

**Ce qui a change : GitHub distingue lui-meme les deux evenements.** `prereleased` ne se declenche
que pour une release cochee, `released` que pour une release qui ne l'est pas. L'ancien declencheur,
`published`, se declenchait pour les deux - c'est ce qui rendait la case invisible. Les deux
affirmations arrivent donc maintenant separement, et `release.yml` les compare : l'evenement dit
l'une, `release_kind()` dit l'autre, et un desaccord est un **refus qui nomme les deux cotes**,
parce que selon celui qui est faux ce n'est pas la meme correction.

Concretement, tu ne peux plus te tromper : ou la release part correctement, ou elle refuse en te
disant quoi changer. **Il n'y a plus rien a surveiller ici.**

### 4.2 Les numeros que les stores exigent, et pourquoi ils ne sont pas la version

Apple veut un `CFBundleShortVersionString` purement numerique et un `CFBundleVersion` unique a chaque
envoi TestFlight ; Play refuse un `versionCode` qu'il a deja accepte. Or `0.15.0-alpha.1` et
`0.15.0-alpha.2` produisent le **meme** numero avec le calcul par defaut de Tauri, qui ignore le
suffixe : le deuxieme envoi serait refuse.

Le bump calcule donc `(majeur * 1000000 + mineur * 1000 + patch) * 100 + rang`, avec `rang = N` pour
`-alpha.N` et **99** pour une stable. Consequences, dans l'ordre que les stores imposent :

```
0.15.0-alpha.1  ->  1500001
0.15.0-alpha.98 ->  1500098
0.15.0          ->  1500099     (au-dessus de toutes ses alphas)
0.15.1-alpha.1  ->  1500101     (au-dessus de la stable precedente)
```

Le nom affiche reste `0.15.0` dans les deux cas - c'est le numero de build qui porte le suffixe.
`0.14.15` avait ete envoye avec le code `14015`, et toute la bande est au-dessus. Trente et une
assertions verifient tout ca dans `.github/scripts/tests/bump-version.test.sh`.

### 4.3 La seule erreur de cette chaine qui atteint un telephone

Un build alpha embarque les secrets `DEV_*`, un build stable ceux de la production. **Il n'y a aucun
repli de l'un vers l'autre**, nulle part - un repli est exactement la maniere dont une alpha finit
par parler a la production. Et les quatre workflows **echouent** si la nature du tag et l'URL
resolue ne sont pas d'accord. C'est une assertion, jamais une convention, parce que c'est le seul
endroit du projet ou une erreur part chez quelqu'un.

### 4.4 Quand publier ?

Il n'y a pas de cadence imposee. Ce qui compte :

- **Une alpha ne coute rien** : elle deploie dev et n'atteint que des testeurs. C'est la maniere
  normale de faire rencontrer un changement a une copie des donnees de production avant de livrer.
- **Une stable est publique** : Play passe en deploiement complet. Elle se fait quand une alpha du
  meme code tourne depuis assez longtemps pour qu'on la croie.

Verifier que Play a bien pris le build est une **mesure**, pas une deduction :
`bun tools/play-vitals/vitals.mjs`. La soumission App Store elle-meme reste un acte humain ; ou en
est chaque moitie est sur [`docs/wiki/frontend/mobile.md`](../wiki/frontend/mobile.md).

---

## 5. Les deux estates

```bash
curl -s https://canari-emse.fr/api/version      # prod : build = null
curl -s https://dev.canari-emse.fr/api/version  # dev  : build = dev.<sha7>
```

Le champ `build` distingue deux deploiements dev d'une meme version. Il est **volontairement absent
en production** : le champ `version` est transforme par les clients en tag de release puis en URL de
telechargement, donc un suffixe dedans produit un 404.

Sur la machine, c'est le nom du projet compose qui dit dans quelle estate on est, et rien d'autre :

```bash
docker ps --filter label=com.docker.compose.project=infrastructure   # production
docker ps --filter label=com.docker.compose.project=canari-dev       # dev
```

**Quel commit la production sert vraiment** ne se lit jamais dans `git log` : le tag `prod-released`
(renomme depuis `prod-deployed` le 2026-09-03) est ecrit par le deploiement qui l'a rendu vrai.

**Dev porte une copie complete de la base de production**, d'ou la banniere permanente et non
fermable en haut de chaque page : sans elle, rien ne distingue les deux a l'ecran. Le
rafraichissement est automatique **tous les lundis a 04:00 UTC**, et a la demande par Actions ->
*Refresh dev.canari-emse.fr from production*. C'est destructif pour dev et pour rien d'autre : tout
ce qui a ete tape dans dev depuis le dernier rafraichissement disparait. La copie retire les jetons
push et les identifiants client Stripe avant la restauration.

**Dev partage les images backend de la production**, deliberement : une difference de comportement
entre les deux estates ne peut donc jamais s'expliquer par un build different. Le frontend est
l'exception, parce que SvelteKit inline `import.meta.env.*` a la compilation.

---

## 6. Les mises a jour de dependances

Dependabot ouvre les PR **sur `main`**, et elles se fusionnent toutes seules quand les tests le
permettent. Un refus n'est **jamais** un renvoi vers une revue humaine : c'est l'affirmation qu'un
test manque, et le message nomme le test qui leverait le blocage. Le detail est sur
[`docs/wiki/cicd.md`](../wiki/cicd.md).

**Ce qui protege la production, c'est qu'un merge ne deploie rien.** Une mise a jour attend sur
`main` que quelqu'un publie une release, et une alpha la fait rencontrer une copie des donnees de
production avant qu'une stable existe. C'est plus lent qu'avant, et surtout c'est **decide par un
humain** au lieu de partir tout seul.

Deux choses sont volontairement retenues : PostgreSQL reste en 15 (le passage a 18 demande une
migration que personne n'a faite - c'est ce qui a cause la panne du 2026-09-01), et les majeures qui
touchent aux datastores attendent le test nomme dans leur refus.

**La regle qui protegeait la campagne de tests a change de declencheur, pas de nature :** un run de
la campagne et une **release** sont mutuellement exclusifs. Un push ne peut plus rien invalider.

---

## 7. Quand ca casse

**Rien ne previent encore que la production est tombee.** Les deux pannes du 2026-09-01 ont ete
signalees par toi ; un run CD rouge ne reveille personne, et le frontend a repondu 200 tout du long.
C'est un element ouvert du backlog, et il attend une decision puis un clic.

En attendant, la verification qui tranche :

```bash
curl -s https://canari-emse.fr/api/version   # doit repondre 200 - ca lit la base de donnees
gh run list --limit 5                        # le pipeline est-il vert et silencieux
```

Sur la machine :

```bash
ssh canari
docker compose -f canari/infrastructure/docker-compose.prod.yml ps
```

> **PowerShell et Git Bash marchent tous les deux depuis le 2026-09-02.** L'ancienne consigne
> "PowerShell uniquement" accusait le mauvais coupable : `~/.ssh/config` ecrit maintenant le chemin
> de la `ProxyCommand` cloudflared avec des barres obliques, que `bash` et `cmd` executent aussi
> bien l'un que l'autre.

**Rejouer un deploiement a moitie rate**, c'est "Re-run failed jobs" sur le run qui existe deja.
Aucune des trois bibliotheques de deploiement n'a de `workflow_dispatch` : ce serait une deuxieme porte vers la machine, et une
deuxieme porte est exactement ce que la migration a supprime.

---

## 8. Ce qu'il reste, et que personne d'autre ne peut faire

1. **Publier `0.15.0-alpha.1`.** C'est la premiere pre-release, et donc le premier passage reel de
   toute la chaine ci-dessus. `0.14.15` reste la stable dans les stores tant qu'une nouvelle stable
   n'est pas publiee.
2. **Verifier le numero de build iOS depuis un Mac.** La seule question que cette machine ne peut
   pas trancher : savoir si `tauri ios build` reecrit `CFBundleVersion` par-dessus ce que le bump y
   a mis. Si oui, TestFlight refusera la deuxieme alpha d'une meme version, et ca se corrige dans
   `ios.yml`.

Le reste de ce qui t'est du - decisions, rotations, clics uniques - est dans **une seule table**,
[`docs/wiki/backlog.md`](../wiki/backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks).
