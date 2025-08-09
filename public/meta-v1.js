document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('metaForm');
  if (!form) return;

  form.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', () => setTag(sel.name, sel.value));
  });

  form.querySelectorAll('input[type=checkbox][name=accent_notes]').forEach(cb => {
    cb.addEventListener('change', () => toggleAccent(cb.value));
  });

  form.querySelectorAll('input[type=checkbox][name=emotion]').forEach(cb => {
    cb.addEventListener('change', () => toggleEmotion(cb.value));
  });
});
