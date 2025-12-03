import http.server
import socketserver

PORT = 8000

class COOPCOEPHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # These headers allow SharedArrayBuffer (required for SQLite OPFS)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

# Allow wasm mimetype to be served correctly
COOPCOEPHandler.extensions_map['.wasm'] = 'application/wasm'

with socketserver.TCPServer(("", PORT), COOPCOEPHandler) as httpd:
    print(f"Serving at http://localhost:{PORT} with COOP/COEP headers...")
    httpd.serve_forever()