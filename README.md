# STATUS SAFI

Tovuti ya Kiswahili ya kuandaa video na picha kwa WhatsApp Status.

## Faili za kuweka GitHub
- `index.html`
- `style.css`
- `app.js`

## Kuweka GitHub Pages kwa iPhone
1. Fungua repo yako ya GitHub.
2. Bonyeza **Add file → Upload files**.
3. Pakia faili hizi tatu kwenye sehemu kuu ya repo (root), si ndani ya folder nyingine.
4. Bonyeza **Commit changes**.
5. Fungua **Settings → Pages**.
6. Chagua **Deploy from a branch**, branch `main`, folder `/ (root)`, kisha **Save**.
7. Subiri GitHub Pages ichapishe tovuti.

## Muhimu kuhusu video
- FFmpeg WebAssembly inapakuliwa mara ya kwanza kutoka jsDelivr; intaneti inahitajika.
- Uchakatishaji unafanyika ndani ya kivinjari kwenye kifaa cha mtumiaji. Video haitumwi kwenye server yetu.
- Kwa video kubwa, simu inaweza kuhitaji RAM na nafasi ya kutosha; funga programu nyingine na usiondoke kwenye ukurasa.
- Tovuti huhifadhi umbo la video bila crop au resize ya makusudi. Video ya mlalo hubaki mlalo; ya wima hubaki wima.
- Muda wa kila sehemu umewekwa sekunde 90 kwa chaguo-msingi, lakini unaweza kubadilishwa kuwa sekunde 60 au 30 kulingana na kikomo kinachoonekana kwenye WhatsApp ya mtumiaji.
- WhatsApp inaweza kubana video tena baada ya kuipakia kwenye Status. Hakuna njia ya website kuhakikisha WhatsApp haitabadilisha ubora.
- Hii ni toleo la mwanzo. Kwenye baadhi ya simu/kivinjari, FFmpeg WebAssembly inaweza kushindwa au kuwa nzito kwa video kubwa.
