(() => {
  const createButton = document.getElementById("btn-criar");

  if (!createButton) {
    return;
  }

  createButton.addEventListener("click", async () => {
    const originalText = createButton.textContent;

    createButton.disabled = true;
    createButton.textContent = "Criando...";

    try {
      const username = document.getElementById("new-user")?.value.trim() ?? "";
      const password = document.getElementById("new-pass")?.value ?? "";
      const feedback = document.getElementById("new-auth-feedback");

      // Um sem o outro nao configura acesso nenhum e so geraria confusao
      // depois, na hora de tentar entrar.
      if (Boolean(username) !== Boolean(password)) {
        if (feedback) {
          feedback.textContent =
            "Preencha usuário e senha, ou deixe os dois em branco.";
        }
        createButton.disabled = false;
        createButton.textContent = originalText;
        return;
      }

      const response = await fetch("/api/session/new", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(username ? { username, password } : {}),
      });

      if (!response.ok) {
        throw new Error("Falha ao criar a sessão.");
      }

      const data = await response.json();

      if (!data || typeof data.id !== "string" || typeof data.adminToken !== "string") {
        throw new Error("Resposta inválida do servidor.");
      }

      window.location.href = `/admin/${data.id}#${data.adminToken}`;
    } catch (error) {
      console.error(error);
      createButton.disabled = false;
      createButton.textContent = "Tentar novamente";

      window.setTimeout(() => {
        createButton.textContent = originalText;
      }, 2500);
    }
  });

})();
