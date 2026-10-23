export function inlinePdf({ pages = 1, text = "PDF MATERIAL 123", commands = "1 0 0 rg 20 20 80 40 re f", raster = false, width = 240, height = 180 } = {}) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  if (raster) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 8 >>\nstream\n00ff00>\nendstream");
  const kids = [];
  for (let i = 0; i < pages; i++) {
    const page = objects.length + 1, content = page + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> ${raster ? "/XObject << /Im0 4 0 R >>" : ""} >> /Contents ${content} 0 R >>`);
    const body = `${raster ? "q 80 0 0 40 20 20 cm /Im0 Do Q" : commands}\n${text ? `BT /F1 16 Tf 20 120 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : ""}\n`;
    objects.push(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  let body = "%PDF-1.7\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

export const pdfAttachment = options => ({ name: "report.pdf", mimeType: "application/pdf", dataBase64: inlinePdf(options).toString("base64") });

// Generated password-protected blank PDF; tests intentionally do not provide its password.
export const encryptedPdf = "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDQzZWJhOTQ1NjM+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyNDAgMTgwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YTgxN2MwMzIxY2ViOTJjMDQ3MDkyMDc2MTA0NjJkZjViZWIwMzJjYzBhYTQ4YTY3MGY5YWVmNTM3NTk2MzdkNj4KL1UgPGM3OWM3NjE2OGU4YWJkZGJjMzM4OTJjMDU2MDk1ODQ4MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDMxNjIzNjMzNjYzNzMwMzMzOTMwNjMzMjM1MzA2MjMwNjMzNjM0MzEzMjMyMzgzNDM2Mzk2MTYzMzA2NDMwNjY+IDwzMTYyMzYzMzY2MzczMDMzMzkzMDYzMzIzNTMwNjIzMDYzMzYzNDMxMzIzMjM4MzQzNjM5NjE2MzMwNjQzMDY2PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK";
