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
      const response = await fetch("/api/session/new", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
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
