<#
    Agenda a coleta diária no Windows.

    Rode UMA VEZ, no PowerShell como administrador:
        Set-ExecutionPolicy -Scope Process Bypass -Force
        .\agendar-windows.ps1

    ATENÇÃO: isso só roda com o computador LIGADO. Se ele passar o dia
    desligado, aquele dia fica sem leitura — e buraco na série não se
    recupera depois, porque o ranking de ontem não existe mais em lugar
    nenhum.

    Para não depender disso, veja .github/workflows/coleta-diaria.yml,
    que roda na nuvem de graça.
#>

$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$coletor = Join-Path $pasta 'collector'

if (-not (Test-Path (Join-Path $coletor 'package.json'))) {
    Write-Host "Não achei a pasta collector. Rode este script de dentro de joompulse-core." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $coletor '.env'))) {
    Write-Host "Falta o arquivo .env em collector. Rode ./setup.sh primeiro." -ForegroundColor Red
    exit 1
}

$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $npm) { Write-Host "npm não encontrado no PATH." -ForegroundColor Red; exit 1 }

$acao = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c cd /d `"$coletor`" && npm run collect rodada >> coleta.log 2>&1" `
    -WorkingDirectory $coletor

# 03:10 da manhã: madrugada, quando o ML responde melhor.
$gatilho = New-ScheduledTaskTrigger -Daily -At 3:10AM

# StartWhenAvailable recupera a execução se o PC estava desligado na
# hora marcada — roda assim que ligar. Não substitui a nuvem, mas
# reduz bastante a chance de perder um dia.
$config = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 5) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName 'GringaRadar-Coleta' `
    -Action $acao -Trigger $gatilho -Settings $config `
    -Description 'Coleta diária de ranking do Mercado Livre' -Force | Out-Null

Write-Host ""
Write-Host "  Tarefa agendada: GringaRadar-Coleta, todo dia às 03:10." -ForegroundColor Green
Write-Host "  O log fica em: $coletor\coleta.log"
Write-Host ""
Write-Host "  Testar agora sem esperar:" -ForegroundColor Cyan
Write-Host "      Start-ScheduledTask -TaskName 'GringaRadar-Coleta'"
Write-Host ""
Write-Host "  Ver quando rodou pela última vez:"
Write-Host "      Get-ScheduledTaskInfo -TaskName 'GringaRadar-Coleta'"
Write-Host ""
Write-Host "  Remover:"
Write-Host "      Unregister-ScheduledTask -TaskName 'GringaRadar-Coleta' -Confirm:`$false"
Write-Host ""
Write-Host "  Lembrete: isso só roda com o computador ligado." -ForegroundColor Yellow
Write-Host "  Para coleta independente, use o GitHub Actions." -ForegroundColor Yellow
Write-Host ""
