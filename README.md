# Status Safi

Website ya kuandaa picha na video kwa vipimo vya WhatsApp status ili zisififie. Ni bure kabisa: hakuna malipo, hakuna usajili, hakuna matangazo. Kazi yote inafanyika kwenye kivinjari cha simu, hakuna faili linalopakiwa kwenye server.

## Inachofanya

- **Picha:** inazibadilisha kuwa 1080×1920 au 720×1280 (uwiano wa 9:16), kwa kujaza skrini au kuziacha nzima bila kukata. Hakuna ukungu wa pembeni.
- **Video:** unachagua sehemu ya kukata, inagawanywa vipande vya sekunde 30, 60 au 90, kila kipande kinalenga chini ya MB 16. Chaguo la 30 au 60 fps, na azimio la 720p au 1080p. Sauti inahifadhiwa.
- **Kuhifadhi na kushiriki:** kitufe cha Hifadhi kinaweka faili kwenye simu. Kitufe cha Shiriki kinaonekana kwenye simu zinazokiruhusu, ili uchague WhatsApp moja kwa moja.

## Mipaka ya kujua

- Video inasindikwa kwa WebCodecs, kwa hiyo inahitaji Chrome ya Android, au kivinjari kipya cha Safari/Chrome kwenye kompyuta. Picha zinafanya kazi karibu kila mahali.
- HDR na Dolby Vision hazitumiki. Kivinjari hakiwezi kuziandika.
- WhatsApp bado inaweza kubana faili baada ya kupost. Hii inapunguza ukungu, haiuondoi kabisa.

## Muundo wa folda

```
index.html        ukurasa mkuu
css/style.css     muonekano
js/app.js         mantiki ya picha na video
favicon.svg       alama ya tab
vendor/           (hiari) nakala ya maktaba ya video, tazama chini
.nojekyll         inaiambia GitHub Pages isichakate faili
```

## Kuweka kwenye GitHub Pages

1. Tengeneza repo mpya kwenye GitHub, kwa mfano `status-safi`.
2. Weka faili zote za folda hii kwenye repo (Add file → Upload files, au `git push`). `index.html` iwe kwenye mzizi wa repo.
3. Nenda Settings → Pages. Chini ya Build and deployment, chagua Deploy from a branch, branch `main`, folda `/ (root)`, kisha Save.
4. Subiri dakika moja hadi mbili. Anwani itakuwa `https://JINA-LAKO.github.io/status-safi/`.

Njia zote za faili ni za jamaa (`css/style.css`, `js/app.js`), kwa hiyo website inafanya kazi iwe kwenye `JINA-LAKO.github.io/status-safi/` au kwenye domain yako mwenyewe.

## Maktaba ya video

Usindikaji wa video unatumia [Mediabunny](https://mediabunny.dev) (toleo 1.50.8). Kwa kawaida inapakiwa kutoka jsDelivr. Ikiwa unataka website isitegemee CDN:

1. Pakua toleo la `.mjs` la Mediabunny kutoka <https://github.com/Vanilagy/mediabunny/releases>.
2. Liweke kwenye folda `vendor/` kwa jina `mediabunny.min.mjs`.

Website inajaribu nakala ya `vendor/` kwanza, kisha CDN.

## Haki

&copy; Queantanamellah HQ
