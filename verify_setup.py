"""
Verifica a conexão com a Meta Marketing API.
Uso: python verify_setup.py
"""

import os
import sys

try:
    from dotenv import load_dotenv
except ImportError:
    print("Erro: python-dotenv não instalado.")
    print("Execute: pip install -r requirements.txt")
    sys.exit(1)

load_dotenv()

REQUIRED_VARS = ["META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN"]


def check_env_vars():
    """Verifica se as variáveis de ambiente estão configuradas."""
    missing = [var for var in REQUIRED_VARS if not os.getenv(var)]
    if missing:
        print("Variáveis de ambiente faltando:")
        for var in missing:
            print(f"  - {var}")
        print("\nConfigure o arquivo .env (veja .env.example)")
        return False
    print("Variáveis de ambiente: OK")
    return True


def test_api_connection():
    """Testa a conexão com a Meta Marketing API."""
    try:
        from facebook_business.api import FacebookAdsApi
        from facebook_business.adobjects.user import User
    except ImportError:
        print("Erro: facebook-business SDK não instalado.")
        print("Execute: pip install -r requirements.txt")
        return False

    access_token = os.getenv("META_ACCESS_TOKEN")
    app_id = os.getenv("META_APP_ID")
    app_secret = os.getenv("META_APP_SECRET")

    FacebookAdsApi.init(app_id, app_secret, access_token)

    try:
        me = User(fbid="me")
        ad_accounts = me.get_ad_accounts(fields=["name", "account_id", "account_status"])

        print(f"\nConexão com a API: OK")
        print(f"Contas de anúncio encontradas: {len(ad_accounts)}")
        print()

        for account in ad_accounts:
            status_map = {1: "ATIVA", 2: "DESATIVADA", 3: "NÃO CONFIRMADA"}
            status = status_map.get(account.get("account_status", 0), "DESCONHECIDO")
            print(f"  - {account.get('name', 'Sem nome')} (act_{account['account_id']}) — {status}")

        return True

    except Exception as e:
        print(f"\nErro ao conectar com a API: {e}")
        print("\nVerifique:")
        print("  1. Se o Access Token é válido e não expirou")
        print("  2. Se o token tem permissões ads_management e ads_read")
        print("  3. Se o App ID e App Secret estão corretos")
        return False


def main():
    print("=" * 50)
    print("Verificação de Setup — Meta Ads API")
    print("=" * 50)
    print()

    if not check_env_vars():
        sys.exit(1)

    if not test_api_connection():
        sys.exit(1)

    print()
    print("Setup verificado com sucesso!")
    print("Você pode usar o MCP server para gerenciar campanhas via Claude.")


if __name__ == "__main__":
    main()
