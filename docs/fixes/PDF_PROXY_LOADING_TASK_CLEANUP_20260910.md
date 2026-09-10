# PDF proxy cleanup — 2026-09-10

## Hallazgo

La validación de `origin/main` fallaba en TypeScript porque `PDFDocumentProxy` no expone `destroy()` en el contrato usado por `unpdf`/PDF.js.

## Causa

`src/tools/pdf/extract-images.ts` intentaba destruir directamente el proxy del documento. El ciclo de vida del worker y de la carga pertenece a `loadingTask`.

## Corrección

El cleanup usa `pdfDocument.loadingTask?.destroy()` cuando está disponible. Se mantiene protegido por `try/catch` para que un fallo de limpieza no oculte el resultado de extracción.

Se añadió `test/test-pdf-image-lifecycle.js`, que crea un PDF mínimo, ejecuta la extracción y comprueba que finaliza sin fuga/bloqueo prolongado.

## Validación

Se debe ejecutar la suite completa del repositorio y el build TypeScript antes de publicar el cambio.
