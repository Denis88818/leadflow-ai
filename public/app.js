/*
  LeadFlow AI — portfolio landing
  --------------------------------
  No secrets live in this file.

  Browser -> same-origin /api/lead -> Cloudflare Worker -> protected n8n webhook.
  The Worker is the only component that knows the X-API-Key.

  The browser submits raw lead context only.
  Internal qualification output is never rendered on the page.
*/

const API_ENDPOINT = '/api/lead';
const REQUEST_TIMEOUT_MS = 15_000;

const form = document.getElementById('lead-form');
const statusEl = document.getElementById('form-status');
const submitButton = form?.querySelector('button[type="submit"]');

const nameField = form?.elements.name;
const emailField = form?.elements.email;
const phoneField = form?.elements.phone;
const messageField = form?.elements.message;
const consentField = form?.elements.consent;

function validateLeadForm() {
  if (!form) return true;

  nameField?.setCustomValidity('');
  emailField?.setCustomValidity('');
  phoneField?.setCustomValidity('');
  messageField?.setCustomValidity('');
  consentField?.setCustomValidity('');

  const name = String(nameField?.value || '').trim();
  const email = String(emailField?.value || '').trim();
  const phone = String(phoneField?.value || '').trim();
  const message = String(messageField?.value || '').trim();

  if (!name) {
    nameField?.setCustomValidity('Please enter your full name.');
    return false;
  }

  if (!email || (emailField && !emailField.checkValidity())) {
    emailField?.setCustomValidity('Please enter a valid email address.');
    return false;
  }

  if (phone) {
    const phoneCharsOk = /^\+?[0-9\s().-]+$/.test(phone);
    const phoneDigits = phone.replace(/\D/g, '');

    if (!phoneCharsOk || phoneDigits.length < 8 || phoneDigits.length > 15) {
      phoneField?.setCustomValidity('Please enter a valid phone number.');
      return false;
    }
  }

  if (!message) {
    messageField?.setCustomValidity('Please describe the problem you want to solve.');
    return false;
  }

  if (!consentField?.checked) {
    consentField?.setCustomValidity('Please agree to the processing of this demo submission.');
    return false;
  }

  return true;
}

[nameField, emailField, phoneField, messageField, consentField]
  .filter(Boolean)
  .forEach((field) => field.addEventListener('input', () => {
    field.setCustomValidity('');
  }));

const scenarios = {
  commerce: {
    name: 'Marie Dupont',
    email: 'marie@demo-company.fr',
    company: 'Demo Commerce',
    phone: '+33 6 12 34 56 78',
    message: 'We run a Shopify store and receive a large number of inbound enquiries. Our team currently qualifies them manually and copies the useful ones into the CRM. We want an n8n automation that can understand each request, remove duplicates, prioritize sales-ready opportunities and alert the team when something important comes in. We are aiming to start this month and expect to invest around 3000 EUR.',
  },
  crm: {
    name: 'Tom Baker',
    email: 'tom@demo-company.com',
    company: 'Example Studio',
    phone: '+44 20 1234 5678',
    message: 'We are evaluating an automation for our inbound sales process. Leads arrive through several channels and the team manually reviews them before entering them into HubSpot. We would like to understand whether n8n can connect the sources, identify duplicate contacts, summarize what the prospect actually needs and recommend the next sales action. We are comparing options this quarter and have not finalized a budget yet.',
  },
  partial: {
    name: 'Tom Baker',
    email: 'tom@demo-company.com',
    company: 'Example Studio',
    phone: '+44 20 1234 5678',
    message: 'We are evaluating an automation for our inbound sales process. Leads arrive through several channels and the team manually reviews them before entering them into HubSpot. We want a system that can understand what each prospect needs and route useful opportunities to sales.',
  },
  research: {
    name: 'Alex Morgan',
    email: 'alex@demo-company.com',
    company: 'Demo Labs',
    phone: '',
    message: 'I am researching automation for a small team and want to understand what an AI lead qualification workflow could look like. There is no confirmed implementation window or budget yet.',
  },
  invalid: {
    name: '',
    email: 'bad@',
    company: '',
    phone: '123',
    message: 'hi',
  },
};

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = `form-status ${type}`;
}

function fillScenario(name) {
  const data = scenarios[name];
  if (!data) return;

  Object.entries(data).forEach(([key, value]) => {
    const field = form.elements[key];
    if (field) field.value = value;
  });

  const consent = form.elements.consent;
  if (consent) consent.checked = true;

  setStatus(`Loaded ${name} sample. Submit it to let the AI decide whether the request has enough information.`);
}

document.querySelectorAll('[data-scenario]').forEach((button) => {
  button.addEventListener('click', () => fillScenario(button.dataset.scenario));
});

function collectPayload() {
  const fd = new FormData(form);
  return {
    name: String(fd.get('name') || '').trim(),
    email: String(fd.get('email') || '').trim(),
    phone: String(fd.get('phone') || '').trim(),
    company: String(fd.get('company') || '').trim(),
    message: String(fd.get('message') || '').trim(),
    source: 'website',
    consent: fd.get('consent') === 'true',
    website: String(fd.get('website') || '').trim(),
  };
}

async function submitPayload(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        response.status >= 500
          ? 'The submission service is temporarily unavailable. Please try again.'
          : 'The submission could not be accepted. Please check your details and try again.'
      );
    }
    return true;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('The submission timed out. Please try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!validateLeadForm()) {
    form.reportValidity();

    const invalidField = [nameField, emailField, phoneField, messageField, consentField]
      .find((field) => field && !field.checkValidity());

    setStatus(
      invalidField?.validationMessage || 'Please check the highlighted fields and try again.',
      'error'
    );
    invalidField?.focus();
    return;
  }

  const payload = collectPayload();
  submitButton.disabled = true;
  form.setAttribute('aria-busy', 'true');
  setStatus('Sending your request…');

  try {
    await submitPayload(payload);
    setStatus('Thanks — your request has been received. Our AI qualification workflow is processing it now.', 'success');
    form.reset();
  } catch (error) {
    setStatus(error?.message || 'Unable to submit the request. Please try again.', 'error');
  } finally {
    submitButton.disabled = false;
    form.removeAttribute('aria-busy');
  }
});