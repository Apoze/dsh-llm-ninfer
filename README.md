# dsh-llm-ninfer

Adaptateur DSH pour le protocole OpenAI Chat de NInfer avec comptage natif. Nécessite la branche DSH `integration/dsh-0.1.5-rc.1-native` basée sur `0.1.5-rc.1` et la version NInfer qui expose les diagnostics v1. Une version publiée portant seulement le même numéro sans ces changements ne suffit pas.

Le plugin possède la transformation des messages, outils et images en un seul corps HTTP. Il compte ce corps via `/v1/chat/completions/count_tokens`, fige les pièces jointes en données, puis utilise la même préparation pour générer. Il ne réimplémente ni le tokenizer ni les outils. Le SDK OpenAI possède HTTP/SSE ; les nouvelles tentatives appartiennent à DSH.

## Installation

Construire DSH et ce plugin avec Node 22.19+ ou 24+. Les dépendances Cordis et DSH doivent résoudre les mêmes instances que le runtime hôte. Installer le paquet construit dans le profil ; ne pas éditer une copie de son cache. La politique complémentaire est `dsh-generation-recovery`.

```yaml
- insert:
    - id: llm-ninfer
      name: dsh-llm-ninfer
      config:
        provider: ninfer-local
        baseURL: http://192.168.1.165:8888/v1
        credentialRef: UNSLOTH_API_KEY
        models:
          - id: huihui-ai/Huihui-Qwen3.8-27B-abliterated-NInfer-NVFP4Full
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
