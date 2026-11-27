'use strict';

window.decodeJianCangImage = async (location, maximumSide) => {
  const url = new URL(location);
  if (url.protocol !== 'jiancang:' || url.host !== 'app' || !url.pathname.startsWith('/board-image/')) return null;
  const image = new Image();
  image.src = location;
  await image.decode();
  const scale = Math.min(1, Math.min(maximumSide, 1440) / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
};

const imageConversions = new Map();

window.cancelJianCangImageConversion = token => imageConversions.get(token)?.();

window.convertJianCangImage = async ({ location, token, format, maximumSide, quality }) => {
  const url = new URL(location);
  if (url.protocol !== 'jiancang:' || url.host !== 'app' || !url.pathname.startsWith('/edit-image/')) return null;
  const image = new Image();
  const canvas = document.createElement('canvas');
  let cancelled = false;
  imageConversions.set(token, () => {
    cancelled = true;
    image.removeAttribute('src');
  });
  try {
    image.src = location;
    try { await image.decode(); }
    catch { return { error: '无法读取这张图片，请确认原件已下载且文件可打开。' }; }
    if (cancelled) return null;
    const { naturalWidth, naturalHeight } = image;
    if (!naturalWidth || !naturalHeight || Math.max(naturalWidth, naturalHeight) > 16384 ||
        naturalWidth * naturalHeight > 80_000_000) {
      return { error: '原件像素尺寸过大，无法批量转换。' };
    }
    const scale = Math.min(1, maximumSide / Math.max(naturalWidth, naturalHeight));
    const width = canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    const height = canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const opaque = format === 'jpeg';
    const context = canvas.getContext('2d', { alpha: !opaque });
    if (opaque) {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const mime = `image/${format}`;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality / 100));
    if (cancelled) return null;
    if (!blob || blob.type !== mime) return { error: '无法生成所选格式的图片。' };
    if (blob.size > 40 * 1024 ** 2) return { error: '生成的图片超过 40 MB，请调小尺寸或改用 JPEG。' };
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { data, width, height };
  } finally {
    imageConversions.delete(token);
    image.removeAttribute('src');
    canvas.width = canvas.height = 0;
  }
};
