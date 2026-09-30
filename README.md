# dsh-llm-ninfer

Adaptateur DSH pour le protocole OpenAI Chat de NInfer avec comptage natif. Nécessite la branche DSH `integration/dsh-0.2.0-rc.1-native` basée sur `0.2.0-rc.1` et la version NInfer qui expose les diagnostics v1. Une version publiée portant seulement le même numéro sans ces changements ne suffit pas.

Le plugin possède la transformation des messages, outils et images en un seul corps HTTP. Il compte ce corps via `/v1/chat/completions/count_tokens`, fige les pièces jointes en données, puis utilise la même préparation pour générer. Il ne réimplémente ni le tokenizer ni les outils. Le SDK OpenAI possède HTTP/SSE ; les nouvelles tentatives appartiennent à DSH.

## Installation

Construire DSH et ce plugin avec Node 22.19+ ou 24+. Les dépendances Cordis et DSH doivent résoudre les mêmes instances que le runtime hôte. Installer le paquet construit dans le profil ; ne pas éditer une copie de son cache. La politique complémentaire est `dsh-generation-recovery`.

Le fork qualifié utilise Cordis `4.0.4`. Ce peer doit pointer vers l'instance du fork compilé, comme les peers DSH.

```yaml
- id: llm-ninfer
  config:
    provider: ninfer-local
    baseURL: http://127.0.0.1:8000/v1
    credentialRef: NINFER_API_KEY
    models:
      - id: your-model-id
        contextWindow: 150000
    contentReserve: 16384
    safetyMargin: 4096
    compactionThreshold: 0.7
    requestTimeoutMs: 1800000
```

Ne pas enregistrer simultanément cette route sous `llm-pi-ai`. `credentialRef` désigne une référence dans le service credentials existant ; aucune clé dans ce fichier. La capacité du serveur comptée fait autorité. Le contrôle des capacités a lieu au premier appel préparé et sur chaque préparation suivante, sans génération de démarrage.

## Budget et terminaison

`G = min(plafond explicite éventuel, capacité − entrée exacte − marge)`. Aucun plafond de sortie arbitraire par défaut. `models[].maxTokens` reste un plafond explicite optionnel. La réflexion utilise `off`, `low`, `medium` ou `xhigh` et son plafond effectif est fourni par NInfer. La réserve de contenu est un minimum recherché par la politique de contexte, pas une prédiction de la longueur d'un fichier.

Les outils sont tamponnés jusqu'à une fin admissible : une génération limitée, annulée, interrompue ou incohérente ne produit aucun appel exécutable. Les fragments natifs restent des diagnostics. Le compte de génération, l'identité serveur et les motifs d'arrêt sont contrôlés. Un serveur redémarré entre comptage et génération refuse explicitement la préparation périmée ; une nouvelle demande prépare un nouveau compte. Il n'existe pas de fallback approximatif silencieux.

Les autres protocoles NInfer restent utilisables par leurs clients, mais cet adaptateur utilise exclusivement Chat Completions. Les URL d'images distantes sont remplacées par les médias immuables de DSH. Le contenu d'une réponse n'est jamais analysé pour inventer des commandes.

## Développement et validation

```sh
npm run build
npm test
```

Les tests ouvrent un vrai serveur HTTP et font passer le SDK OpenAI dans ses chemins SSE, annulation, erreur 409 et incohérence de compte. Ils vérifient les objets émis, notamment l'absence d'outil exécutable, sans rechercher des mots dans le code source. Les essais GPU et clients complets sont consignés dans le rapport de qualification du chantier.

## Compatibilité DSH 0.2.0-rc.1

Cette version cible les contrats V4 de DSH et Cordis 4.0.4. L’installation locale utilise le fork natif NInfer basé sur le tag officiel `dsh-v0.2.0-rc.1`. Les anciens plugins de récupération finale ne doivent pas être activés en parallèle avec `dsh-generation-recovery`.

Pour développer contre le fork natif : installer les dépendances, puis exécuter `DSH_NATIVE_ROOT=/chemin/du/fork node scripts/link-native-core.mjs` avant la compilation. Les liens restent locaux dans `node_modules` ; les manifests et fichiers de verrouillage restent portables.

## Gestionnaire de plugins DSH

Le paquet déclare un bundle natif (`dsh.bundle.patch`) : il apparaît dans **Plugins → Installed**, avec activation/désactivation et désinstallation du profil. Installer le dossier construit avec `dsh plugin --profile web add /chemin/du/paquet`. Aucune publication GitHub ou npm n’est nécessaire.

Le bundle est le seul propriétaire de l’entrée `llm-ninfer`. Ne pas conserver une ancienne directive `insert` pour cette même entrée : remplacer celle-ci par un patch `id`/`config`, sans `name`. Les réglages utilisateur restent hors du paquet. Les interrupteurs agissent sur le profil sélectionné ; ne pas désactiver pendant une génération.

Depuis la version **0.2.2**, ouvrir **Plugins → Installed → dsh-llm-ninfer** pour configurer le plugin directement dans le gestionnaire natif. Aucun changement du code de DSH n’est nécessaire.

1. Activer le composant NInfer. Une installation vide reste configurable : aucun fournisseur n’est enregistré avant de renseigner l’URL et au moins un modèle.
2. Saisir l’URL API (avec `/v1`), l’identifiant du fournisseur et la référence de credential, puis ajouter les modèles avec leur identifiant exact, nom facultatif, contexte et plafond de sortie facultatif.
3. Régler la réserve de contenu, la marge, le seuil de compaction et le délai HTTP, puis **Enregistrer la configuration**. Les réglages sont persistés dans le profil DSH ouvert, hors du paquet.
4. La section **Clé API** indique si la référence enregistrée possède déjà une clé. Laisser le champ vide la conserve ; saisir une nouvelle clé et cliquer **Enregistrer la clé** la remplace dans le service credentials natif de DSH. La clé existante n’est jamais renvoyée au formulaire. Les références en lecture seule ne sont pas modifiables.

Les changements s’appliquent aux nouveaux appels sans redémarrage. Un appel préparé conserve sa connexion et son budget. Les doublons de modèles, URL contenant des identifiants ou paramètres, valeurs invalides et conflits de fournisseur sont refusés. Si les réglages changent ailleurs pendant une édition, recharger les valeurs avant d’enregistrer.

Le niveau de raisonnement reste dans le sélecteur de modèle de DSH ; les autres politiques de compaction restent dans les presets de l’agent. Aucun serveur ni secret n’est embarqué. Désactiver ce bundle retire le fournisseur et empêche les conversations NInfer jusqu’à sa réactivation ; cela n’arrête pas le serveur GPU.
