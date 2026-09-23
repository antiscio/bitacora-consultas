# Bitácora de Consultas

Web app para astrólogas: toma la grabación de una consulta (de Zoom o grabada desde la app), la transcribe y arma un informe con:

- Resumen y puntos clave
- Situación del consultante (motivo, estado emocional, áreas de vida)
- Toda la astrología que se habló (carta natal, revolución solar, tránsitos, progresiones, eclipses…), con cuándo, área e interpretación
- Fechas
- Recomendaciones, preguntas del consultante y temas para la próxima consulta
- Transcripción completa como guion ("ASTRÓLOGA: …" / "CONSULTANTE: …")

Cada consulta queda guardada en una **biblioteca** ordenada por consultante (historial, astrología mencionada a lo largo del tiempo, búsqueda y notas propias), y se puede descargar como **Word (.docx)** o **texto (.txt)**. Los audios no se guardan; solo el texto.

**Costo: $0.** Usa el plan gratuito de [Groq](https://console.groq.com): Whisper Large v3 para transcribir, Qwen 3.8 para identificar quién habla cuando no se puede por la voz, y GPT-OSS 120B para analizar (si se agota su cupo diario, sigue con GPT-OSS 20B).

**Quién habla:** si Zoom graba un audio por participante (Configuración → Grabación → "Grabar un archivo de audio separado para cada participante"), el guion sale exacto. Si hay un solo audio con las dos voces, la app reconoce las voces por cómo suenan, en la compu y sin mandar nada afuera (modelo WeSpeaker, ~26 MB, se descarga la primera vez; usa la placa de video si hay). Aprende la voz de la astróloga con cada consulta. Si se equivoca, en la transcripción se toca el nombre para corregirlo, o "Invertir voces". Si el reconocimiento de voces no está disponible, la IA lo deduce por el contexto.

**Fidelidad:** cada mención astrológica y cada fecha traen la frase textual de la que salen, para poder verificarlas.

## Cómo funciona

```
Zoom graba (un audio .m4a con las dos voces)
  → se arrastra la carpeta a la app
  → la app quita los silencios y parte el audio (en el navegador)
  → Groq transcribe
  → Groq analiza la conversación por partes y une el resultado
  → se guarda en la biblioteca (en el navegador) → descarga .docx / .txt
```

- Es una página estática (HTML + JS, sin compilar). Se puede alojar gratis en GitHub Pages.
- La clave de Groq se guarda **solo en el navegador** de quien la usa (localStorage). Nunca va al repositorio.
- La biblioteca se guarda en el navegador (IndexedDB), en la compu donde se usa. Desde **Configuración → Respaldo** se descarga un archivo con todo para guardarlo (por ejemplo en Google Drive) o pasarlo a otra compu.
- Si la consulta quedó en varios audios (p. ej. WhatsApp), se suben todos juntos: cada uno es una parte y se ordenan por el nombre del archivo.
- Con Zoom gratis la reunión se corta a los 40 min. Si se reabre y se vuelve a grabar, quedan varias carpetas. Se arrastran todas juntas y la app las ordena por fecha y hora.

### Límites del plan gratis de Groq (septiembre 2026)

| Uso | Límite |
|---|---|
| Transcripción | 2 h de audio por hora, 8 h por día, archivos de hasta 25 MB |
| Análisis | 8.000 tokens por minuto y 200.000 por día, **por modelo** |

Una consulta de 1 h 20 min usa aprox. 1 h 20 min de audio y unos 50 a 60 mil tokens del modelo de análisis (más unos 25 mil de Qwen si hay que identificar quién habla), y tarda unos 8 a 10 minutos. Alcanza para varias consultas por día. Cuando se llega al límite por minuto, la app espera sola y lo muestra en pantalla. Groq rechaza pedidos de más de 8.000 tokens: la app manda la conversación en pedazos y, si alguno igual se pasa, lo divide sola.

## Puesta en marcha

### 1. Clave de Groq (gratis)
1. Entrar a <https://console.groq.com/keys> (con cuenta de Google).
2. **Create API Key** → copiarla.
3. Recomendado: en la consola de Groq, **Settings → Data Controls** → activar **Zero Data Retention**.
4. En la app: **Configuración** → pegar la clave → **Probar clave** → **Guardar**.

### 2. Zoom
1. En cada consulta: **Grabar → Grabar en esta computadora**. Si la reunión se corta y se reabre, volver a grabar.
2. Al terminar, Zoom deja una carpeta con `audio<números>.m4a` (las dos voces juntas) y un video. Se arrastra la carpeta a la app: usa el audio e ignora el video, y separa las dos voces por cómo suenan.
3. Opcional: en Zoom → Configuración → **Grabación**, activar **"Grabar un archivo de audio separado para cada participante"** y poner en la app el **nombre con el que aparece en Zoom**. Así la transcripción sale con cada voz identificada.

### 3. Publicar en GitHub Pages
1. Crear un repositorio en GitHub (puede ser privado solo con GitHub Pro; si es público, no hay problema: no contiene datos ni claves).
2. Subir estos archivos:
   ```bash
   git remote add origin https://github.com/USUARIO/bitacora-consultas.git
   git push -u origin main
   ```
3. En GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
4. La app queda en `https://USUARIO.github.io/bitacora-consultas/`.
5. En el celular, abrir ese link en Chrome → menú → **Agregar a pantalla principal**.

### 4. Biblioteca en la nube (compu y celular)
La biblioteca se puede sincronizar con un **repositorio privado de GitHub solo de datos** (ej. `antiscio/bitacora-datos`). Todo se **encripta en el navegador** (AES-GCM de 256 bits) antes de subirse: en GitHub solo quedan archivos ilegibles con nombres al azar. La llave vive únicamente en los dispositivos vinculados.

1. Crear un permiso ("fine-grained token") en <https://github.com/settings/personal-access-tokens/new>: acceso **solo** al repositorio de datos, permiso **Contents: Read and write**, vencimiento lo más largo posible.
2. En la app: **Configuración → Biblioteca en la nube** → repositorio + permiso → **Conectar**.
3. Para el celular: **Vincular celular** muestra un código QR. Se escanea con la cámara del celular y la app queda conectada (incluye la clave de Groq). Se hace una sola vez por dispositivo.

Sincroniza sola al abrir la app, al volver a ella, cada 5 minutos y después de cada cambio. Si se edita lo mismo en dos dispositivos, gana la versión más reciente.

## Probar en la computadora

Hace falta un servidor local (los módulos JS no funcionan abriendo el archivo directo):

```bash
python serve.py
```

y abrir <http://localhost:8765>.

## Estructura

| Archivo | Qué hace |
|---|---|
| `index.html`, `css/styles.css` | Interfaz |
| `js/app.js` | Arranque y navegación entre pantallas (`#/nueva`, `#/biblioteca`, `#/consultante/…`, `#/sesion/…`) |
| `js/views/nueva.js` | Nueva consulta: audios, consultante, procesamiento |
| `js/views/biblioteca.js` | Biblioteca, búsqueda y ficha de cada consultante |
| `js/views/sesion.js` | Consulta guardada: resumen, tránsitos y fechas, transcripción, notas, descargas |
| `js/db.js` | Biblioteca en IndexedDB y respaldo |
| `js/cloud.js` | Biblioteca en la nube: encriptación y sincronización con un repositorio privado |
| `js/settings.js` | Configuración (clave, nombres, modelos) |
| `js/ui.js` | Utilidades de interfaz (íconos, fechas, avisos) |
| `js/files.js` | Recibe carpetas/archivos y adivina orden y voces |
| `js/audio.js` | Decodifica a 16 kHz, detecta voz, quita silencios, parte en WAV ≤ 8 min |
| `js/groq.js` | Llamadas a Groq con esperas automáticas por límites |
| `js/transcribe.js` | Transcripción, filtro de "alucinaciones" de Whisper, orden por tiempo |
| `js/diarize.js` | Reconocimiento de voces en el navegador (quién habla) |
| `js/analyze.js` | Prompt de análisis astrológico, análisis por partes y unión |
| `js/export.js` | Informe en .docx y .txt |
| `js/recorder.js` | Plan B: grabar micrófono (+ audio de la llamada) desde el navegador |

## Privacidad

Los audios y transcripciones pasan por los servidores de Groq para ser procesados. Por contrato, Groq no usa los datos de la API para entrenar modelos, y por defecto no los guarda. Además, en la consola de Groq se puede activar **Zero Data Retention** (Settings → Data Controls) para que no guarde nada ni siquiera para diagnóstico ([detalle](https://console.groq.com/docs/your-data)). Hay que avisarle al consultante que la sesión se graba (Ley 25.326 de Protección de Datos Personales).

## Ideas para más adelante


- Resumen de evolución entre consultas de un mismo consultante.
- Calcular los tránsitos reales con efemérides para verificar las fechas.
- Cambiar el análisis a Claude (pago por uso) si se quiere más calidad.
