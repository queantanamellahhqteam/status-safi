# STATUS SAFI

Tovuti ya Kiswahili ya kuandaa video na picha kwa WhatsApp Status. Mwanzo una chaguo mbili tu: Boresha video na Boresha picha.

## Faili za kuweka GitHub
- `index.html`
- `style.css`
- `app.js`

## Kuweka GitHub Pages kwa iPhone
1. Fungua repo yako ya GitHub.
2. Bonyeza **Add file → Upload files**.
3. Fungua ZIP, kisha pakia `index.html`, `style.css` na `app.js` moja kwa moja kwenye sehemu kuu ya repo (root), si ndani ya folder nyingine. Kama mafaili yapo tayari, chagua kuyabadilisha (Replace).
4. Bonyeza **Commit changes**.
5. Fungua **Settings → Pages**.
6. Chagua **Deploy from a branch**, branch `main`, folder `/ (root)`, kisha **Save**.
7. Subiri GitHub Pages ichapishe tovuti.

## Muhimu kuhusu video
- FFmpeg WebAssembly inapakuliwa mara ya kwanza kutoka jsDelivr; intaneti inahitajika.
- Uchakatishaji unafanyika ndani ya kivinjari kwenye kifaa cha mtumiaji. Video haitumwi kwenye server yetu.
- Kwa video kubwa, simu inaweza kuhitaji RAM na nafasi ya kutosha; funga programu nyingine na usiondoke kwenye ukurasa.
- Tovuti huhifadhi umbo la video bila crop au resize ya makusudi. Video ya mlalo hubaki mlalo; ya wima hubaki wima.
- Video hugawanywa automatic kwa vipande vya sekunde 60. Hakuna ukurasa au chaguo tofauti la kugawa video. Video ya sekunde 60 au chini hutengenezwa kama sehemu moja.
- WhatsApp inaweza kubana video tena baada ya kuipakia kwenye Status. Hakuna njia ya website kuhakikisha WhatsApp haitabadilisha ubora.
- Hii ni toleo la mwanzo. Kwenye baadhi ya simu/kivinjari, FFmpeg WebAssembly inaweza kushindwa au kuwa nzito kwa video kubwa.
