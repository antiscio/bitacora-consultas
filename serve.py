# Servidor local para probar la app, sin caché (siempre sirve la última versión).
# Uso: python serve.py   →   http://localhost:8765
# (Acepta PUT en /_prueba/<archivo> para guardar archivos generados durante pruebas.)
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_PUT(self):
        if not self.path.startswith("/_prueba/"):
            self.send_error(404)
            return
        name = os.path.basename(self.path)
        os.makedirs("_prueba", exist_ok=True)
        with open(os.path.join("_prueba", name), "wb") as f:
            f.write(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(201)
        self.end_headers()


ThreadingHTTPServer(("localhost", 8765), NoCache).serve_forever()
